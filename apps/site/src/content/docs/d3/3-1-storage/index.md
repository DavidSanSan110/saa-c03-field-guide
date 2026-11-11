---
title: 'Task 3.1: Determine high-performing and/or scalable storage solutions'
description: 'Block, file and object storage compared, S3 request rates per prefix, multipart upload, Transfer Acceleration, byte-range fetches and S3 Express One Zone, EBS volume types and instance store, EFS and the four FSx file systems, and hybrid storage with Storage Gateway, DataSync and Transfer Family, with exam cues and common traps.'
---

Storage questions in this task describe a workload (a database that needs steady IOPS, thousands of servers reading the same files, a factory uploading video from another continent) and ask which storage service, and which setting of it, keeps up. Start from how the data is accessed: as blocks by one server, as files by many, or as objects over HTTPS. That narrows the answer to one family; the performance details then pick the option inside it.

Part of [Domain 3: Design High-Performing Architectures](/d3/).

## Block, file or object

| Type   | Service        | Accessed by                                                              | Scope                                  | Scales by                                                        |
| ------ | -------------- | ------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------- |
| Block  | Amazon EBS     | One EC2 instance (io1/io2 Multi-Attach: up to 16 in one AZ)              | One AZ                                 | Changing size, IOPS and throughput with Elastic Volumes          |
| Block  | Instance store | The instance on the host it is attached to                               | One host; gone when the instance stops | Choosing a bigger instance type                                  |
| File   | Amazon EFS     | Thousands of Linux and macOS clients over NFS                            | Region (or One Zone)                   | Automatically, to petabytes                                      |
| File   | Amazon FSx     | Windows (SMB), Linux HPC (Lustre), multi-protocol (ONTAP), NFS (OpenZFS) | One AZ or two AZs, depending on type   | Storage and throughput you provision (some types grow on demand) |
| Object | Amazon S3      | Any client over HTTPS, through the S3 API                                | Region (S3 Express One Zone: one AZ)   | Automatically, with no limit on total size                       |

- **Block storage** is a raw disk: the OS puts a file system on it, and it gives the lowest latency for a single server. It's the answer for databases and boot volumes.
- **File storage** is a shared directory tree with locks and permissions that many servers mount at once.
- **Object storage** keeps whole objects under keys. There are no partial updates, but there is no capacity to plan either, and any number of clients can read in parallel.

## S3 performance

S3 scales request rates by itself. An application can make at least **3,500 PUT, COPY, POST or DELETE** and **5,500 GET or HEAD requests per second per prefix**, and a bucket can have any number of prefixes. The prefix is the part of the key before the object name: `logs/2026/11/a.gz` and `images/a.jpg` are in different prefixes, so spreading keys over ten prefixes allows ten times the rate. While S3 scales up for a new, sudden load it can answer `503 Slow Down`; clients should retry with exponential backoff.

| Technique                | Speeds up                           | How it works                                                                                                            |
| ------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| More prefixes            | Requests per second                 | Each prefix has its own request rate, so parallel clients reading or writing different prefixes add up                  |
| Multipart upload         | Uploads                             | The object is split into up to 10,000 parts uploaded in parallel; a failed part is retried alone                        |
| S3 Transfer Acceleration | Long-distance uploads and downloads | Clients send data to the nearest CloudFront edge location, which carries it to the bucket's Region over the AWS network |
| Byte-range fetches       | Downloads                           | Several GET requests with a `Range` header fetch parts of one object in parallel, or just the part you need             |
| Amazon CloudFront        | Repeated reads by users             | Popular objects are cached at edge locations, so most reads never reach the bucket                                      |
| S3 Express One Zone      | Latency                             | Directory buckets in one AZ answer in single-digit milliseconds; put the compute in the same AZ                         |

- **Multipart upload** is recommended from about 100 MB and required above 5 GB, the largest single PUT. Parts are 5 MiB to 5 GiB (the last can be smaller), which allows objects of up to 50 TB. Uploads that are never completed or aborted keep their parts, and you pay for them: add a lifecycle rule that aborts incomplete multipart uploads after a few days.
- **Transfer Acceleration** is turned on per bucket and used through a separate endpoint, `bucketname.s3-accelerate.amazonaws.com`. The bucket name can't contain periods. You pay only for transfers that it actually speeds up; the speed comparison tool shows the gain per Region before you commit.
- **Byte-range fetches** also make downloads more resilient: a failed range is retried alone. Aligning ranges with the part sizes used at upload gives the best throughput.
- **S3 Express One Zone** stores objects in a **directory bucket** in one Availability Zone and authorises requests with short-lived sessions (`CreateSession`), which removes per-request overhead. A directory bucket takes up to 200,000 reads and 100,000 writes per second by default, without any prefix design, and its requests cost up to 80 % less than S3 Standard's (its storage costs more). It suits ML training, analytics and other jobs that read the same data many times from compute in that AZ. It is designed for 99.95 % availability, and its data doesn't survive the loss of the AZ.
- **SSE-KMS can be the bottleneck.** Every upload and download of a KMS-encrypted object calls KMS, and KMS has request quotas per Region. An S3 Bucket Key cuts those calls.
- The general purpose storage classes that answer in milliseconds (Standard, Glacier Instant Retrieval, the instant tiers of Intelligent-Tiering, and both IA classes) all get the same per-prefix request rates. Glacier Flexible Retrieval, Glacier Deep Archive and Intelligent-Tiering's optional archive tiers need a restore first, so they never fit a "fast access" question.

## EBS volumes and instance store

An EBS volume is a network-attached disk in one AZ. Its performance is set by its **type** and, for most types, by the IOPS and throughput you provision.

| Volume type                              | Media | Max IOPS | Max throughput | Size           | Pick it for                                                                         |
| ---------------------------------------- | ----- | -------- | -------------- | -------------- | ----------------------------------------------------------------------------------- |
| gp3 (General Purpose SSD)                | SSD   | 80,000   | 2,000 MiB/s    | 1 GiB–64 TiB   | Most workloads: boot volumes, dev and test, most databases                          |
| gp2 (General Purpose SSD)                | SSD   | 16,000   | 250 MiB/s      | 1 GiB–16 TiB   | Older volumes; IOPS grow with size (3 per GiB)                                      |
| io2 Block Express (Provisioned IOPS SSD) | SSD   | 256,000  | 4,000 MiB/s    | 4 GiB–64 TiB   | Critical databases: above 80,000 IOPS, sub-millisecond latency, 99.999 % durability |
| io1 (Provisioned IOPS SSD)               | SSD   | 64,000   | 1,000 MiB/s    | 4 GiB–16 TiB   | Older high-IOPS volumes; io2 is more durable for the same price                     |
| st1 (Throughput Optimized HDD)           | HDD   | 500      | 500 MiB/s      | 125 GiB–16 TiB | Large sequential reads: big data, data warehouses, log processing                   |
| sc1 (Cold HDD)                           | HDD   | 250      | 250 MiB/s      | 125 GiB–16 TiB | Rarely read sequential data at the lowest cost                                      |

- **gp3 separates performance from size.** Every gp3 volume gets 3,000 IOPS and 125 MiB/s, and you pay to add more (up to 500 IOPS per GiB, so a 160 GiB volume can already have the maximum). On gp2, a small volume can only get more IOPS by growing. gp3 is also about 20 % cheaper per GiB, and Elastic Volumes moves a gp2 volume to gp3 in place.
- **Only SSD volumes can be boot volumes.** The HDD types are measured in MiB/s for big, sequential I/O; small random I/O is what SSDs are for.
- **The instance is also a limit.** A volume can't go faster than the instance's EBS bandwidth: a large io2 volume on a small instance won't reach its provisioned IOPS. Use an EBS-optimised (all current Nitro) instance type sized for the volume.
- **Elastic Volumes** change the size, type, IOPS or throughput of an attached volume while it is in use. The file system still has to be extended afterwards. A volume can't shrink, and it takes at most four changes in any 24 hours.
- **Multi-Attach** (io1 and io2 only) attaches one volume to up to 16 Nitro instances in the same AZ. The application or a cluster-aware file system must coordinate writes; ext4 and XFS can't.
- **Volumes restored from a snapshot** load their blocks from S3 the first time each block is read, so first reads are slow. **Fast snapshot restore** (set per snapshot and AZ, billed while it is on) gives full performance at once. A cheaper middle way is a **provisioned volume initialization rate** of 100–300 MiB/s, which loads the whole volume in a predictable time.
- **RAID 0** across several volumes adds up their IOPS and throughput for one instance, beyond what a single volume allows.

**Instance store** is disk on the physical host. It gives the highest IOPS and lowest latency (NVMe SSDs on storage-optimised types such as I4i reach millions of random IOPS) at no extra charge, but it's **ephemeral**: the data survives a reboot and is lost when the instance stops, hibernates or terminates, or when the disk fails. Use it for caches, buffers, scratch data and replicated data (a distributed database or a Kafka cluster that copies its data across nodes), never as the only copy.

## Shared file systems: EFS and FSx

| Service                     | Protocols                 | Clients                                                | Availability                                            | Pick it for                                                                                    |
| --------------------------- | ------------------------- | ------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Amazon EFS                  | NFS v4.0 and v4.1         | Linux and macOS (EC2, containers, Lambda), not Windows | Regional (multi-AZ) or One Zone                         | Shared web content, home directories, CMS uploads: grows and shrinks on its own                |
| FSx for Windows File Server | SMB                       | Windows (Linux and macOS over SMB)                     | Single-AZ or Multi-AZ                                   | Windows apps and file shares joined to Active Directory, with NTFS ACLs and DFS Namespaces     |
| FSx for Lustre              | Lustre (POSIX)            | Linux                                                  | One AZ (Intelligent-Tiering stores the data across AZs) | HPC, ML training, media rendering: up to TB/s, sub-millisecond latency, linked to S3           |
| FSx for NetApp ONTAP        | NFS, SMB, iSCSI, NVMe/TCP | Linux, Windows, macOS                                  | Single-AZ or Multi-AZ                                   | Moving NetApp or mixed NFS/SMB workloads; snapshots, SnapMirror, instant clones, deduplication |
| FSx for OpenZFS             | NFS v3, v4.0, v4.1, v4.2  | Linux, Windows, macOS                                  | Single-AZ or Multi-AZ                                   | Moving ZFS or Linux NFS servers; very low latency, snapshots and instant clones                |

**EFS settings that change performance**

- **Throughput mode.** **Elastic** (the console default and AWS's recommendation) scales with the workload, up to 20–60 GiB/s of reads and 1–5 GiB/s of writes per file system depending on the Region, and bills per GB read and written: the choice for spiky or unknown loads. **Provisioned** sets a fixed throughput regardless of size, for steady loads that need more than Bursting gives; after choosing it or raising it you have to wait 24 hours to lower it or switch back. **Bursting** ties throughput to the amount of data stored (50 KiB/s per GiB, with bursts), so a small file system is slow.
- **Performance mode.** **General Purpose** (the default) has the lowest latency per operation and is what AWS recommends. **Max I/O** is a previous-generation mode for highly parallel workloads: it has higher latency and doesn't work with Elastic throughput or One Zone. The mode can't be changed after creation.
- **Storage classes.** Lifecycle management moves files that haven't been read for a while (by default 30 days) to **Infrequent Access**, and later to **Archive** (Regional file systems with Elastic throughput only). Both cost less to store but more to read, with first-byte latency in tens of milliseconds instead of about a millisecond. A file read from IA or Archive stays there unless the lifecycle policy moves it back to Standard on first access.
- **Clients outside AWS.** On-premises Linux servers can mount EFS over Direct Connect or Site-to-Site VPN. To copy a large data set into EFS, AWS recommends DataSync over plain NFS copies, which slow down with network latency.

**FSx for Lustre deployment types.** **Scratch** file systems don't replicate data and are for short, cheap processing jobs. **Persistent** file systems replicate within the AZ and replace failed servers, for longer jobs; the newer **Intelligent-Tiering** storage class of persistent file systems stores the data across AZs (the file servers stay in one AZ) and moves cold data to cheaper tiers. File systems can be linked to an S3 bucket with a **data repository association**: the file system shows the bucket's objects as files, loads each one on first read, and can export results back to S3.

- **EFS or FSx?** Linux clients that need a shared POSIX file system with no capacity to manage: EFS. Windows, SMB or Active Directory: FSx for Windows File Server. The fastest parallel file system, often in front of S3: FSx for Lustre. An existing NetApp, a need for NFS, SMB and iSCSI at once, or block-level replication: FSx for NetApp ONTAP. A ZFS or Linux NFS server to move as it is, with very low latency: FSx for OpenZFS.
- **EFS doesn't support Windows.** Windows instances need an SMB share instead: FSx for Windows File Server, or the multi-protocol FSx for NetApp ONTAP.
- **FSx for NetApp ONTAP Multi-AZ** uses floating IP addresses, so clients outside its VPC (on premises or in a peered VPC) reach its NFS and SMB endpoints through a **Transit Gateway**; iSCSI and NVMe/TCP don't need one.

## Hybrid storage and data transfer

These services connect on-premises systems to AWS storage, either to keep using local protocols with the data in AWS or to move the data once.

| Gateway type    | On-premises side                | Stored in AWS as                                                                                                      | Use it for                                                                                                                      |
| --------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| S3 File Gateway | NFS or SMB file shares          | One S3 object per file (Standard, Standard-IA, One Zone-IA or Intelligent-Tiering; lifecycle rules can archive later) | Apps and users that write files locally while the data lands in S3, with a local cache of recent files                          |
| Volume Gateway  | iSCSI block volumes             | Volumes in S3, backed up as EBS snapshots                                                                             | **Cached** volumes: data in AWS, recent data cached locally. **Stored** volumes: all data on site, copied to AWS asynchronously |
| Tape Gateway    | Virtual tape library over iSCSI | Virtual tapes in S3, archived to S3 Glacier Flexible Retrieval or Deep Archive                                        | Existing backup software that writes to tape, without physical tapes                                                            |

- A gateway runs on site as a virtual machine (VMware ESXi, Hyper-V, KVM or Nutanix AHV) or on EC2; the hardware appliance is no longer sold. Its local cache is what gives on-premises users low-latency access to data that lives in AWS.
- The **FSx File Gateway**, a local cache for FSx for Windows File Server shares, is no longer available to new customers.

**AWS DataSync** copies data online between on-premises storage (NFS, SMB, HDFS, object storage), other clouds and AWS storage (S3 in any storage class, EFS, every FSx type). Copies from on-premises storage go through a **DataSync agent** installed near it; copies between AWS storage services need no agent. Tasks run on demand or on a schedule, copy only what changed, keep file metadata and permissions, verify the data, and can be limited in bandwidth; one task can fill a 10 Gbps link. It is for migrations and recurring syncs, not continuous replication (for S3 to S3, that is S3 Replication).

**AWS Transfer Family** gives partners and legacy systems an SFTP, FTPS, FTP or AS2 endpoint whose files are stored in S3 or EFS, so they keep their client software while the data goes straight into AWS. Plain FTP is allowed only on an endpoint inside a VPC.

**AWS Snowball Edge** devices, the offline option for shipping very large data sets, are no longer available to new customers, and AWS ends their support on 31 December 2026. For new migrations AWS points to DataSync over the network, or to **AWS Data Transfer Terminal** locations where you bring your own storage devices to upload. Older exam questions may still offer Snowball Edge for "huge data set, too little bandwidth": recognise it, but know that it is closed to new customers.

## If the exam says… → think…

| If the exam says…                                                                          | Think…                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| S3 returns 503 Slow Down under a high request rate                                         | Spread keys over more prefixes; retry with backoff    |
| Upload multi-gigabyte files faster and resume failed transfers                             | Multipart upload                                      |
| Users on other continents upload to one bucket slowly                                      | S3 Transfer Acceleration                              |
| Download only part of a large object, or download it in parallel                           | Byte-range fetches                                    |
| Single-digit millisecond access to S3 data from compute in one AZ                          | S3 Express One Zone (directory bucket)                |
| Requests to an SSE-KMS bucket are throttled well below the S3 prefix limits                | KMS request quotas: S3 Bucket Key or a quota increase |
| One EBS volume needs more than 80,000 IOPS, sub-millisecond latency or 99.999 % durability | io2 Block Express                                     |
| Raise IOPS without buying a bigger volume                                                  | gp3 with extra provisioned IOPS (not gp2)             |
| Big sequential reads at low cost, throughput rather than IOPS, not a boot volume           | st1 (rarely read, lowest cost per GB: sc1)            |
| Highest random I/O for temporary data or a self-replicating cluster                        | Instance store                                        |
| Several instances in one AZ write to the same block volume                                 | io2 Multi-Attach with a cluster-aware file system     |
| Volume restored from a snapshot must be fast at once                                       | Fast snapshot restore                                 |
| Linux instances in several AZs share files, size unknown                                   | Amazon EFS                                            |
| EFS throughput varies widely or is unknown                                                 | Elastic throughput mode                               |
| Windows file shares with Active Directory and NTFS permissions                             | FSx for Windows File Server                           |
| HPC or ML job needs a parallel file system over data in S3                                 | FSx for Lustre with a data repository association     |
| Move a NetApp NAS, or one file system for NFS, SMB and iSCSI clients                       | FSx for NetApp ONTAP                                  |
| On-premises apps keep writing files over NFS or SMB, data stored in S3                     | S3 File Gateway                                       |
| Replace physical backup tapes, keep the backup software                                    | Tape Gateway                                          |
| On-premises iSCSI volumes backed up to AWS, all data kept on site                          | Volume Gateway, stored volumes                        |
| Move or sync terabytes from an on-premises NAS to S3, EFS or FSx on a schedule             | AWS DataSync with an agent                            |
| Partners send files over SFTP straight into S3                                             | AWS Transfer Family                                   |

## Common traps

- **An EBS volume lives in one AZ.** To use it in another AZ, snapshot it and create a new volume there.
- **Instance store data doesn't survive a stop.** A reboot keeps it; stop, hibernate and terminate don't.
- **Multi-Attach isn't a shared file system.** It works only with io1 and io2, in one AZ, and needs a cluster-aware file system. For shared files use EFS or FSx.
- **gp2 IOPS depend on size**; gp3 IOPS don't. "More IOPS on a small volume" means gp3 or io2.
- **HDD volumes can't boot an instance.**
- **The instance caps EBS performance.** Provisioning more IOPS than the instance's EBS bandwidth allows changes nothing.
- **EFS doesn't work with Windows.** Windows shares mean FSx for Windows File Server.
- **FSx for Lustre scratch file systems keep no replica.** Use persistent for anything longer than a short job.
- **S3 request limits are per prefix, not per bucket.** More prefixes, more requests per second.
- **Transfer Acceleration helps distance, not request rate.** Uploads from the same Region gain nothing.
- **S3 Express One Zone is one AZ.** It is for speed, not for data that must survive an AZ failure.
- **DataSync runs as tasks**, on demand or on a schedule. It isn't a continuous replication service.
- **Storage Gateway is a hybrid bridge**: it keeps local protocols on site. To move data once and stop, use DataSync.

## Links

**AWS documentation**

- [Best practices design patterns: optimizing Amazon S3 performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)
- [Uploading and copying objects using multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) and [S3 Transfer Acceleration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/transfer-acceleration.html)
- [S3 Express One Zone](https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-high-performance.html)
- [Amazon EBS volume types](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html), [Multi-Attach](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volumes-multi.html) and [fast snapshot restore](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-fast-snapshot-restore.html)
- [Instance store temporary block storage](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/InstanceStorage.html)
- [Amazon EFS performance specifications](https://docs.aws.amazon.com/efs/latest/ug/performance.html)
- [Choosing an Amazon FSx file system](https://aws.amazon.com/fsx/when-to-choose-fsx/) and [using data repositories with FSx for Lustre](https://docs.aws.amazon.com/fsx/latest/LustreGuide/fsx-data-repositories.html)
- [What is AWS Storage Gateway?](https://docs.aws.amazon.com/storagegateway/latest/userguide/WhatIsStorageGateway.html)
- [What is AWS DataSync?](https://docs.aws.amazon.com/datasync/latest/userguide/what-is-datasync.html) and [What is AWS Transfer Family?](https://docs.aws.amazon.com/transfer/latest/userguide/what-is-aws-transfer-family.html)

**Practice**

- [Practice tests](/practice/): in the **Practice** card, choose **Practice by: Task** and then **3.1** to drill only this task.
