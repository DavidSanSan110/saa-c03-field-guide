---
title: 'Task 4.1: Design cost-optimized storage solutions'
description: 'What each storage service charges for, the S3 storage classes with their minimum durations, object sizes and retrieval fees, S3 Intelligent-Tiering, lifecycle rules and Storage Class Analysis, hidden S3 costs (old versions, unfinished uploads, requests, replication) and Requester Pays, EBS gp3, snapshots, Snapshots Archive and Recycle Bin, EFS and FSx cost settings, backup cold storage, low-cost data transfer into AWS and the tools that find storage waste, with exam cues and common traps.'
---

Cost questions about storage describe data whose value changes over time (logs nobody reads after a week, scans that auditors open once a quarter, backups kept seven years for compliance) and ask for the cheapest design that still meets the access, durability and retention needs. Work out three things first: **how often** the data is read, **how fast** it must come back when it is, and **how long** it must be kept. Those three answers pick the storage class and the lifecycle; the traps are in minimum durations, minimum object sizes and retrieval fees that make a "cheaper" class cost more.

Which storage type fits a workload (block, file or object) and how fast each one is is in [task 3.1](/d3/3-1-storage/). This page is about what they cost. The tools that track and analyse spend for every task (Budgets, Cost Explorer, Cost Anomaly Detection, Compute Optimizer, Trusted Advisor) are on the [Domain 4 overview](/d4/#cost-management-tools).

Part of [Domain 4: Design Cost-Optimized Architectures](/d4/).

## What each storage service charges for

| Service        | You pay for                                                                                                                                                                         | Main cost levers                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Amazon S3      | GB-months stored (by storage class), requests, retrievals, data transfer out, some features                                                                                         | Storage class, lifecycle rules, cleaning up old versions and unfinished uploads |
| Amazon EBS     | The size you **provision** (used or not), extra IOPS and throughput, snapshots                                                                                                      | gp3 instead of gp2, right size, delete unattached volumes and old snapshots     |
| Instance store | Nothing extra: it comes with the instance type                                                                                                                                      | Use it for temporary data instead of paying for an EBS volume                   |
| Amazon EFS     | GB-months **actually stored** (by storage class), throughput (Elastic: per GB read and written; Provisioned: per MiB/s above the baseline), reads and transitions in IA and Archive | Lifecycle to Infrequent Access and Archive, One Zone, the right throughput mode |
| Amazon FSx     | Storage you provision (or data stored, in Intelligent-Tiering), throughput capacity, backups                                                                                        | Deduplication and compression, HDD or capacity pool tiers, Single-AZ, scratch   |

An EBS volume bills for its whole size even when it is half empty, and even when its instance is stopped. EFS costs more per GB than EBS but bills only for the data in it, so for a shared or unpredictably growing data set it can still be the cheaper choice.

**Does it grow by itself?** S3 and EFS grow and shrink with the data, so there is nothing to size and nothing to pay for in advance. An EBS volume never grows on its own: you size it, watch it and extend it with Elastic Volumes. Most FSx file systems also have a provisioned size. Database storage that grows by itself (RDS storage autoscaling, Aurora) is in [task 4.3](/d4/4-3-database-costs/).

## S3 storage classes

All classes are designed for the same durability (11 nines). They differ in price per GB, availability, number of AZs, and the conditions that come with the lower price.

| Storage class                 | AZs | Minimum days billed | Smallest size billed            | Getting data back                                                    | Use it for                                                 |
| ----------------------------- | --- | ------------------- | ------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| S3 Standard                   | ≥ 3 | None                | None                            | Milliseconds, no retrieval fee                                       | Frequently read data                                       |
| S3 Intelligent-Tiering        | ≥ 3 | None                | None (under 128 KB: no tiering) | Milliseconds in the instant tiers, no retrieval fee                  | Unknown or changing access patterns                        |
| S3 Standard-IA                | ≥ 3 | 30 days             | 128 KB                          | Milliseconds, fee per GB retrieved                                   | Data read about once a month that must come back at once   |
| S3 One Zone-IA                | 1   | 30 days             | 128 KB                          | Milliseconds, fee per GB retrieved                                   | Infrequently read data you can re-create, secondary copies |
| S3 Glacier Instant Retrieval  | ≥ 3 | 90 days             | 128 KB                          | Milliseconds, higher fee per GB retrieved                            | Archives read about once a quarter that must open at once  |
| S3 Glacier Flexible Retrieval | ≥ 3 | 90 days             | 40 KB of overhead per object    | Restore first: expedited 1–5 min, standard 3–5 h, bulk 5–12 h (free) | Archives read once or twice a year, backups                |
| S3 Glacier Deep Archive       | ≥ 3 | 180 days            | 40 KB of overhead per object    | Restore first: standard within 12 h, bulk within 48 h                | Data kept for years for compliance, rarely or never read   |

- **Minimum storage duration** means you pay for that many days even if you delete, overwrite or move the object earlier: the remaining days are charged as an early deletion fee.
- **Minimum billable size**: in the IA classes and Glacier Instant Retrieval, a 10 KB object is billed as 128 KB. In the two restore classes, every object carries about 40 KB of index and metadata, part of it billed at the S3 Standard rate. Many small files cost less once they are bundled into one archive (tar or zip) before they go there.
- **Restored objects** from Glacier Flexible Retrieval and Deep Archive are temporary copies: for the days you ask for, you pay for the archive and for the copy (at the Standard rate). Bulk retrieval is free from Glacier Flexible Retrieval.
- **Availability** is 99.99 % for Standard, 99.9 % for Intelligent-Tiering, Standard-IA and Glacier Instant Retrieval, and 99.5 % for One Zone-IA. One Zone-IA data is lost if its AZ is destroyed, so it suits copies and data that can be rebuilt (thumbnails, transcoded media), never the only copy of something that matters.
- **S3 Express One Zone** is the reverse trade: storage costs more than Standard, requests cost less, and it is in one AZ. It is a performance class, covered in [task 3.1](/d3/3-1-storage/#s3-performance).

### S3 Intelligent-Tiering

Intelligent-Tiering watches each object and moves it between tiers by itself. In exchange you pay a small **monitoring fee** every month for each object it watches. There are no retrieval fees, no fees for moving between tiers, and no minimum storage duration.

| Tier                           | Object moves there after                  | Access                            |
| ------------------------------ | ----------------------------------------- | --------------------------------- |
| Frequent Access                | Upload, or any access                     | Milliseconds                      |
| Infrequent Access              | 30 days in a row without access           | Milliseconds                      |
| Archive Instant Access         | 90 days in a row without access           | Milliseconds                      |
| Archive Access (optional)      | A number of days you set, from 90 to 730  | Restore first, standard 3–5 hours |
| Deep Archive Access (optional) | A number of days you set, from 180 to 730 | Restore first, within 12 hours    |

- An object that is read again goes back to Frequent Access, so a sudden burst of reads doesn't bring retrieval fees.
- **Objects smaller than 128 KB** are never moved out of Frequent Access and pay no monitoring fee: Intelligent-Tiering saves nothing on them.
- The two archive tiers are off until you turn them on for the bucket, a prefix or a tag. Turn them on only if the application can wait for a restore.
- Choose Intelligent-Tiering when you can't predict access (data lakes, user content, new applications). When the pattern is known ("read for 30 days, then almost never"), a lifecycle rule is cheaper because it has no monitoring fee.

## S3 Lifecycle rules

A lifecycle configuration is a set of rules on a bucket. Each rule selects objects with a **filter** (prefix, object tags, object size, or a combination) and applies **actions**:

| Action                                 | What it does                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Transition current versions            | Moves objects to a colder storage class a number of days after they were created            |
| Expire current versions                | Deletes objects (in a versioned bucket, adds a delete marker) after a number of days        |
| Transition noncurrent versions         | Moves old versions to a colder class a number of days after they became noncurrent          |
| Permanently delete noncurrent versions | Removes old versions after a number of days, optionally keeping the newest few              |
| Delete expired object delete markers   | Removes delete markers that no longer have any versions behind them                         |
| Abort incomplete multipart uploads     | Deletes the parts of uploads that were never completed, a number of days after they started |

- **Transitions run one way.** A rule moves objects down a fixed order towards Glacier Deep Archive (Standard-IA may also move to Intelligent-Tiering), never back to Standard. To bring data back to a warmer class, copy it (after a restore, for the archive classes).
- **Any class from day 0.** Since July 2026, lifecycle can move objects to any class, Standard-IA and One Zone-IA included, from the day they are created; before that, the IA classes needed 30 days in S3 first, and older practice questions may still assume that wait. The minimum storage charges still apply.
- **Within one rule, each step waits out the minimum.** A rule that moves objects to Glacier Instant Retrieval on day 4 can't move them on to Deep Archive before day 94. Two separate rules can, but then you pay the early deletion fee.
- **Small objects stay put.** By default, lifecycle doesn't transition objects smaller than 128 KB; a size filter in the rule can change that.
- **Each transition is a request you pay for**, per object. For millions of small objects the transition fees can be more than the storage they save: bundle small files first, or keep them where they are.
- **Billing follows the rule, not the work.** Lifecycle actions run in the background and can lag, but you stop paying for an expired object once the rule says it expires, and the new class's price applies once the object qualifies (for Intelligent-Tiering, only once it has actually moved).
- **Storage Class Analysis** watches how objects in a bucket, prefix or tag group are read and suggests when moving them from Standard to Standard-IA pays off. It only analyses that move (not One Zone-IA or Glacier). First data appears after 24–48 hours, but it needs about 30 days of observation before it recommends an age; it can export a daily CSV report. Use it to choose the number of days in a transition rule.

**Two typical designs**

- Original videos are read often for 60 days, then rarely, and must come back within 5 hours when they are. Transcoded copies (several MB each) can be rebuilt from the originals, are rarely watched after the first week and are deleted at day 60. Originals: Standard, then a transition to Glacier Flexible Retrieval at day 60. Transcodes: One Zone-IA, with an expiration at day 60.
- Deleted or overwritten files must be recoverable at once for 30 days and within two days for a year. A simple low-cost rule: turn on versioning, transition noncurrent versions to Glacier Deep Archive 30 days after they become noncurrent, permanently delete them after 365, and add **Delete expired object delete markers** to clean up what is left.

## Hidden S3 costs

- **Old versions.** With versioning on, every overwrite and delete keeps the previous version, and each one is billed like any object. A versioned bucket without a noncurrent-version rule only grows.
- **Unfinished multipart uploads.** Parts of uploads that were never completed or aborted are stored and billed, but they don't show up as objects in a listing. A lifecycle rule that aborts them after a few days is the standard fix.
- **Requests.** Every PUT, COPY, POST, LIST and GET is billed, and writes cost more than reads. Uploading millions of tiny files one by one costs more in requests than in storage: batch them into larger objects where the application allows it.
- **Replication** stores a second copy and pays for the replication requests, the data transfer between Regions (for Cross-Region Replication) and, if turned on, Replication Time Control. The replica can use a cheaper storage class than the source: Glacier Deep Archive for a copy that exists only for disaster recovery.
- **Data transfer out.** Data uploaded into S3 is free; data downloaded to the internet or to another Region is not, while transfer from S3 to CloudFront is free. Network costs are in [task 4.4](/d4/4-4-network-costs/).
- **Changing many existing objects** at once (a new storage class, new tags, a restore from Glacier) is a job for **S3 Batch Operations**, with an S3 Inventory report as the list of objects. Lifecycle rules then keep new objects in line.

### Requester Pays

Normally the bucket owner pays for storage, requests and data downloaded. On a **Requester Pays** bucket, the owner still pays for storage, but whoever makes the request pays for the request and the data transfer. It suits large shared data sets (research data, public reference data) whose owner doesn't want to pay for everyone's downloads.

- Requesters must be authenticated AWS identities and must say they accept the charge (the `x-amz-request-payer` header, or `--request-payer requester` in the CLI). Anonymous requests are refused.
- If the requester uses an IAM role in the bucket owner's account, the bucket owner pays.

## EBS volumes and snapshots

Volume types and their limits are in [task 3.1](/d3/3-1-storage/#ebs-volumes-and-instance-store). The cost side:

- **gp3 over gp2.** gp3 is up to 20 % cheaper per GB than gp2, includes 3,000 IOPS and 125 MiB/s at any size, and lets you buy extra IOPS without buying extra GB. Elastic Volumes changes a gp2 volume to gp3 in place, with no downtime and no detaching.
- **Pay only for the IOPS you need.** A gp2 volume made bigger just to get IOPS, or an io1/io2 volume provisioned far above its real load, wastes money; gp3 with extra IOPS is often enough below 80,000 IOPS. Choose io2 over io1: it costs the same and is more durable.
- **HDD volumes** (st1, sc1) cost much less per GB than SSD for large, sequential data; see [task 3.1](/d3/3-1-storage/#ebs-volumes-and-instance-store) for when they fit.
- **Size what you need.** A volume can grow with Elastic Volumes but never shrink. Start small and grow; to get a smaller volume, create it and copy the data across.
- **Unattached volumes keep billing.** A volume in the `available` state costs the same as an attached one. When an instance terminates, its root volume is deleted by default, but data volumes are often kept (by default when attached after launch, and when added at launch in the console): check their **Delete on termination** flag.

**Snapshots** are incremental: the first one copies every used block, later ones only the blocks that changed, and you pay for the data stored. Deleting a snapshot removes only the data no other snapshot needs.

| Feature                       | What it does                                                                                                                                                    | Cost notes                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| EBS Snapshots Archive         | Moves a snapshot to a low-cost archive tier as a **full** snapshot; it must be restored (up to 72 hours) before a volume can be created from it                 | Up to 75 % cheaper storage; 90-day minimum; a fee per GB restored                    |
| Recycle Bin                   | Keeps deleted EBS snapshots and EBS-backed AMIs for 1–365 days, and deleted EBS volumes for 1–7 days, so they can be restored                                   | Volumes and snapshots in the Recycle Bin are billed at their normal rate             |
| Amazon Data Lifecycle Manager | Creates, copies and deletes snapshots and EBS-backed AMIs on a schedule, for resources selected by tag, and archives snapshots from monthly or yearly schedules | No charge for the policies; you pay for the snapshots                                |
| Fast snapshot restore         | Volumes created from the snapshot get full performance at once                                                                                                  | Billed per hour for each snapshot and AZ where it is on: turn it off when not needed |

- **Archive what is kept long and rarely restored**: monthly or yearly snapshots kept for compliance, or the last snapshot of a project that has ended. An archived snapshot stores every block, not just changes, so archiving one of a chain of daily snapshots can save little or even cost more.
- **AMIs keep their snapshots by default.** Deregistering an AMI leaves the snapshots behind it, still billed, unless you choose **Delete associated snapshots** (`--delete-associated-snapshots` in the CLI) or delete them afterwards.- For backups across many services, with one policy and copies to other Regions and accounts, use **AWS Backup** ([task 2.2](/d2/2-2-high-availability/)).

## EFS and FSx

EFS performance settings and storage classes are in [task 3.1](/d3/3-1-storage/#shared-file-systems-efs-and-fsx). The cost side:

- **Lifecycle management** moves files that haven't been read for a set time to **Infrequent Access** (by default after 30 days) and later to **Archive** (by default after 90 days), each cheaper to store and more expensive to read (transitions and reads from them are charged per GB). Small files are moved too, but in IA and Archive each file is billed as at least 128 KiB. Archive needs a Regional file system with Elastic throughput and has a 90-day minimum storage duration; IA has none. Choose whether a file returns to Standard on first access: yes for files that become busy again, no for files read once (an audit, a scan) and forgotten again.
- **One Zone** file systems store the data in one AZ and cost less than Regional ones: for development, data that can be rebuilt, or data already backed up elsewhere.
- **Throughput mode.** Elastic bills per GB read and written, so it is cheap for spiky or light use and expensive for constant heavy use; a steady, heavy load costs less on Provisioned. Bursting needs no throughput fee but ties speed to size.

| FSx type                    | Cost levers                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| FSx for Windows File Server | HDD storage instead of SSD for general file shares, data deduplication, Single-AZ where Multi-AZ isn't required          |
| FSx for Lustre              | Scratch file systems for short jobs, data compression, the Intelligent-Tiering storage class, keeping the data set in S3 |
| FSx for NetApp ONTAP        | A small SSD tier plus the elastic, cheaper **capacity pool** tier with tiering policies, deduplication and compression   |
| FSx for OpenZFS             | The Intelligent-Tiering storage class (pay for data stored), data compression, Single-AZ where Multi-AZ isn't required   |

## Backup and archive

| Need                                                | Low-cost answer                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Backups kept for months or years, rarely restored   | AWS Backup lifecycle to **cold storage** (for resource types that support it)       |
| Objects kept for years for compliance, never read   | S3 Glacier Deep Archive, uploaded directly or through a lifecycle rule              |
| Archives read a few times a year, must open at once | S3 Glacier Instant Retrieval                                                        |
| Backup software that writes to tape                 | Tape Gateway, archiving virtual tapes to Glacier Flexible Retrieval or Deep Archive |
| EBS snapshots kept for compliance                   | EBS Snapshots Archive, automated with Data Lifecycle Manager or AWS Backup          |
| Old data must be kept unchanged and undeletable     | S3 Object Lock or AWS Backup Vault Lock ([task 1.3](/d1/1-3-data-security/))        |

**AWS Backup cold storage.** A backup plan's lifecycle can move recovery points to cold storage after a number of days, and delete them later. Recovery points must stay in cold storage for at least 90 days, so the retention period has to be at least 90 days longer than the time before the move. Not every resource type supports it: EBS (through EBS Snapshots Archive, for backups taken monthly or less often), EFS, DynamoDB with AWS Backup's advanced features and a few others do; S3 doesn't (S3 backups have their own lower-cost tier instead).

## Moving data into AWS storage

The cheapest transfer depends on how much data there is, how often it moves and the bandwidth available. The services themselves are compared in [task 3.1](/d3/3-1-storage/#hybrid-storage-and-data-transfer).

- **Data in is free.** S3 doesn't charge for data uploaded from the internet. A one-off upload over an existing connection costs only the requests; with good bandwidth, plain uploads or the CLI's multipart upload are often enough.
- **AWS DataSync** charges per GB copied. It is the managed choice for large or recurring copies from NAS, other clouds or between AWS storage services, and can write straight into the target storage class. Recurring syncs into IA or Glacier classes can bring early deletion fees when files are changed and rewritten.
- **Storage Gateway** charges for the data it writes to AWS plus the storage used. It is for ongoing hybrid access, not a one-time move.
- **Transfer Family** charges per hour for each protocol turned on at an endpoint, plus per GB transferred: worth it for partners who must keep using SFTP, not for internal copies.
- **Direct Connect** lowers the cost of data transferred out, and gives steady bandwidth for regular large transfers ([task 4.4](/d4/4-4-network-costs/)).
- **Write into the right class from the start.** Uploading straight into Standard-IA, a Glacier class or Deep Archive saves the Standard PUT, the later transition request and the days billed in Standard. A PUT into those classes still costs more than a PUT into Standard.
- **Snowball Edge** is closed to new customers ([task 3.1](/d3/3-1-storage/#hybrid-storage-and-data-transfer)); older exam questions may still offer it for "too much data for the network".

## Finding storage waste

| Tool                      | What it shows                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3 Storage Lens           | Storage use and activity across the organisation, accounts, Regions, buckets and prefixes, with cost-efficiency metrics such as noncurrent version bytes and incomplete multipart upload bytes |
| S3 Storage Class Analysis | When objects in a bucket stop being read, to set Standard → Standard-IA transitions                                                                                                            |
| S3 Inventory              | A scheduled list of objects with their storage class, size and encryption, for audits and Batch Operations                                                                                     |
| AWS Compute Optimizer     | EBS volumes that are idle or unattached, or whose type, size, IOPS or throughput could cost less                                                                                               |
| AWS Trusted Advisor       | Underutilised EBS volumes and other cost checks                                                                                                                                                |
| Cost Explorer             | S3 and EBS spend by usage type (storage, requests, retrievals, transfer) and by tag                                                                                                            |

**S3 Storage Lens** has free metrics, which you can query for 14 days, and a default dashboard for the account that can't be deleted (it can be turned off). **Advanced metrics** are paid: activity, detailed cost-optimisation and data-protection metrics, prefix-level aggregation, publishing to CloudWatch, and 15 months of history. With AWS Organizations, one dashboard covers every account.

## If the exam says… → think…

| If the exam says…                                                                  | Think…                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Access pattern is unknown or changes, objects are large enough to tier             | S3 Intelligent-Tiering                                         |
| Data is read for 30 days, then almost never                                        | Lifecycle rule: Standard, then a colder class after 30 days    |
| Read once a quarter, must open in milliseconds                                     | S3 Glacier Instant Retrieval                                   |
| Archive restored once or twice a year, a few hours' wait is fine                   | S3 Glacier Flexible Retrieval                                  |
| Kept for years for compliance, a 12–48-hour restore is fine, lowest cost           | S3 Glacier Deep Archive                                        |
| Infrequently read data that can be re-created, lowest cost with millisecond access | S3 One Zone-IA                                                 |
| Millions of tiny objects, a colder class is suggested                              | Probably not worth it: 128 KB minimum and per-object fees      |
| Objects deleted or moved within weeks of upload                                    | Avoid classes with 30-, 90- or 180-day minimums                |
| Bucket bill grows but the objects listed don't                                     | Incomplete multipart uploads or noncurrent versions: lifecycle |
| Old versions must be recoverable for a while, then cheaply kept, then deleted      | Noncurrent version transition + expiration                     |
| Find out when to move objects from Standard to Standard-IA                         | S3 Storage Class Analysis                                      |
| Storage usage and waste across all accounts and buckets in the organisation        | S3 Storage Lens (advanced metrics for prefixes and history)    |
| Others download a big shared data set, the owner shouldn't pay for it              | S3 Requester Pays                                              |
| Cheaper EBS without changing the application or stopping the instance              | gp2 → gp3 with Elastic Volumes                                 |
| Old EBS snapshots kept for compliance, restore in days is fine                     | EBS Snapshots Archive                                          |
| Recover snapshots or AMIs deleted by mistake                                       | Recycle Bin retention rule                                     |
| Automate snapshot creation, retention and deletion by tag                          | Amazon Data Lifecycle Manager (or AWS Backup across services)  |
| Shared Linux files, most rarely read after a month                                 | EFS lifecycle to Infrequent Access and Archive                 |
| Backups kept a year, older ones almost never restored                              | AWS Backup lifecycle to cold storage (90-day minimum)          |
| Replace a physical tape library at the lowest cost                                 | Tape Gateway with Glacier Deep Archive                         |
| DR copy of a bucket in another Region at the lowest cost                           | Cross-Region Replication into a cold storage class             |

## Common traps

- **One Zone-IA isn't for the only copy.** It is lost with its AZ.
- **The IA classes and Glacier Instant Retrieval bill at least 128 KB per object**, and Glacier Flexible Retrieval and Deep Archive add about 40 KB per object.
- **Minimum durations apply on delete, overwrite and transition.** Moving or deleting an object early still charges the remaining days.
- **Glacier Flexible Retrieval and Deep Archive need a restore** before an object can be read. "Must open immediately" rules them out; Glacier Instant Retrieval is the archive class that reads in milliseconds.
- **Lifecycle never moves objects back to a warmer class.** Getting data back into Standard takes a copy (after a restore, for the archive classes).
- **Intelligent-Tiering doesn't tier objects under 128 KB** and charges a monitoring fee per larger object. For a known pattern, lifecycle is cheaper.
- **Versioning without a noncurrent-version rule** grows the bill for ever.
- **Requester Pays doesn't move the storage cost.** The owner still pays for storage; requesters pay for requests and transfer.
- **An EBS volume bills for its provisioned size**, attached or not, used or not, and stopped instances still pay for their volumes.
- **EBS volumes can't shrink.** A smaller volume means a new volume and a copy.
- **Deregistering an AMI keeps its snapshots by default**, and you keep paying for them.
- **An archived EBS snapshot is a full copy.** Archiving one of many daily incremental snapshots can cost more.
- **AWS Backup cold storage needs 90 days** in cold storage, so short retention periods can't use it.

## Links

**AWS documentation**

- [Understanding and managing Amazon S3 storage classes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html) and [how S3 Intelligent-Tiering works](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intelligent-tiering-overview.html)
- [Managing the lifecycle of objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) and [transitioning objects using S3 Lifecycle](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-transition-general-considerations.html)
- [Storage Class Analysis](https://docs.aws.amazon.com/AmazonS3/latest/userguide/analytics-storage-class.html) and [S3 Storage Lens](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage_lens.html)
- [Using Requester Pays buckets](https://docs.aws.amazon.com/AmazonS3/latest/userguide/RequesterPaysBuckets.html)
- [Amazon EBS snapshots](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-snapshots.html), [EBS Snapshots Archive](https://docs.aws.amazon.com/ebs/latest/userguide/snapshot-archive.html), [Recycle Bin](https://docs.aws.amazon.com/ebs/latest/userguide/recycle-bin.html) and [Amazon Data Lifecycle Manager](https://docs.aws.amazon.com/ebs/latest/userguide/snapshot-lifecycle.html)
- [Amazon EFS storage classes](https://docs.aws.amazon.com/efs/latest/ug/features.html#storage-classes) and [lifecycle management](https://docs.aws.amazon.com/efs/latest/ug/lifecycle-management-efs.html)
- [AWS Backup lifecycle and cold storage](https://docs.aws.amazon.com/aws-backup/latest/devguide/plan-options-and-configuration.html#backup-lifecycle)

**Practice**

- [Practice tests](/practice/): in the **Practice** card, choose **Practice by: Task** and then **4.1** to drill only this task.
