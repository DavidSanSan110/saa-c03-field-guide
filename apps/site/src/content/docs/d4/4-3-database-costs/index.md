---
title: 'Task 4.3: Design cost-optimized database solutions'
description: 'What RDS, Aurora, DynamoDB and ElastiCache charge for, storage that grows by itself, Reserved Instances, Database Savings Plans and DynamoDB reserved capacity, Aurora Serverless v2 and I/O-Optimized, DynamoDB capacity modes and table classes, licences and engines, stopping non-production databases, backup and retention costs, caching and proxies to cut database spend, cheaper database types and migrations, with exam cues and common traps.'
---

Cost questions about databases describe a data set and how it is used (a relational database busy only in office hours, a table that grows by gigabytes a month but is rarely read, an Oracle licence the company wants to drop, backups kept for seven years) and ask for the cheapest design that still meets the need. Work out four things first: **how steady** the load is, **what dominates the bill** (instance hours, storage, I/O or requests), **how long the data must be kept**, and **whether the engine itself costs money** (licences, extended support). Steady load → a commitment. Variable or idle load → serverless or on-demand capacity. Mostly reads of the same data → a cache. Old data → somewhere cheaper than the live database.

Which database fits a data model, and how RDS, Aurora, DynamoDB capacity modes, ElastiCache and DMS work, is in [task 3.3](/d3/3-3-databases/). Multi-AZ, failover and disaster recovery are in [task 2.2](/d2/2-2-high-availability/). This page is about what they cost. The tools that track and analyse spend for every task (Budgets, Cost Explorer, Compute Optimizer, Trusted Advisor, cost allocation tags) are on the [Domain 4 overview](/d4/#cost-management-tools).

Part of [Domain 4: Design Cost-Optimized Architectures](/d4/).

## What each database charges for

| Service                                | You pay for                                                                                                                                                          | Main cost levers                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Amazon RDS                             | Instance hours (per second, 10 minutes minimum), provisioned storage and IOPS, backup storage beyond the free amount, data transfer, licences for commercial engines | Instance class and size, Reserved Instances or a Savings Plan, Single-AZ for non-production, stopping |
| Amazon Aurora                          | Instance hours or Aurora capacity units (Serverless v2), storage used, I/O requests (Aurora Standard only), backup storage beyond the free amount                    | Serverless v2 for variable load, I/O-Optimized for I/O-heavy clusters, commitments                    |
| Amazon DynamoDB                        | Read and write request units (on-demand) or provisioned capacity per hour, storage per GB-month, backups, global table replication, streams reads                    | Capacity mode, table class, reserved capacity, TTL, smaller items                                     |
| Amazon ElastiCache                     | Node hours (node-based), or data stored and ElastiCache Processing Units (serverless), backup storage                                                                | Valkey instead of Redis OSS, node size, reserved nodes, data tiering                                  |
| DocumentDB, Neptune, Keyspaces, others | Similar models: instances or serverless capacity, storage, I/O or requests                                                                                           | The same levers, and the same commitments (Reserved Instances, Database Savings Plans)                |

- **Multi-AZ doubles the instance.** An RDS Multi-AZ DB instance pays for the primary and the standby; a Multi-AZ DB cluster pays for three instances. Production needs it ([task 2.2](/d2/2-2-high-availability/#database-high-availability)); development and test usually don't.
- **Read replicas are full instances.** Each RDS read replica bills its own instance hours and storage. Aurora Replicas share the cluster volume, so they add instance hours but no storage.
- **A stopped database still pays for storage** and backups ([below](#non-production-and-part-time-databases)).

### Storage that grows by itself

| Database    | Grows by itself?                                                                          | Shrinks?                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| RDS         | Only with **storage autoscaling** turned on, up to a maximum you set                      | No: allocated storage can't be reduced in place                                                                                               |
| Aurora      | Yes, always: the cluster volume grows as data is added                                    | Yes, when tables or partitions are dropped or truncated; space freed by deleting rows is reused, and returned only after the table is rebuilt |
| DynamoDB    | Yes, with no limit; you pay for the data stored                                           | Yes                                                                                                                                           |
| ElastiCache | Serverless caches scale by themselves; node-based clusters have the memory of their nodes | Serverless: yes                                                                                                                               |

- **RDS storage autoscaling** grows the volume when free space is below 10 % of the allocated storage for at least five minutes, the previous storage change has finished optimising, and there have been fewer than four storage changes in the last 24 hours. It protects against running out of space without paying for a large volume up front. Set the **maximum storage threshold** so a runaway job can't grow the bill without limit.
- **RDS storage only grows.** To get back space you don't need, move the data to a new, smaller instance (a dump and load, AWS DMS, or a blue/green deployment where the engine supports shrinking storage).
- **RDS storage type**: gp3 includes a baseline of IOPS and throughput in the storage price, and above a size threshold (none for SQL Server) lets you buy more separately; Provisioned IOPS (io1, io2) costs more and is only worth it for steady, very high I/O. Magnetic storage is retired: new instances can't use it.

## Paying less for steady load

| Commitment                 | Term                                                   | Applies to                                                                                                                              | Flexibility                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RDS Reserved Instances     | 1 or 3 years                                           | One engine, instance class family and Region; provisioned Aurora instances too                                                          | Size flexibility within a family for most open-source engines and Aurora, and for those engines also between Single-AZ and Multi-AZ (Multi-AZ uses twice the units); no change of engine, family or Region |
| Database Savings Plans     | 1 year, no upfront payment                             | A $/hour commitment across Aurora, RDS, DynamoDB, ElastiCache (Valkey only), DocumentDB, Neptune, Keyspaces and other database services | Any engine, size, deployment and Region, on current-generation instances (7th generation and newer) and serverless options                                                                                 |
| DynamoDB reserved capacity | 1 year (3 years in some Regions), partly paid up front | Provisioned read and write capacity of tables in the Standard table class, in one Region                                                | None: a fixed number of RCUs and WCUs                                                                                                                                                                      |
| ElastiCache reserved nodes | 1 or 3 years                                           | One node type family and Region                                                                                                         | Size flexibility within a family; Redis OSS reservations also cover Valkey nodes                                                                                                                           |

- **Reserved Instances bill whether the database runs or not**, like EC2 ones, and they can't be cancelled. Payment options are All Upfront, Partial Upfront and No Upfront (1 year only), with the biggest discount for paying up front. They apply to instance hours only, not to storage, I/O, backups or Extended Support charges.
- **Size flexibility.** An RDS Reserved Instance for a `db.r7g.large` running MySQL, MariaDB, PostgreSQL, Aurora or Oracle with your own licence also covers half of a `db.r7g.xlarge`, or two `db.r7g.medium`. It doesn't apply to SQL Server or to licence-included Oracle, which need the exact size.
- **Database Savings Plans** (up to 35 %, launched in December 2025) are the database version of Compute Savings Plans ([task 4.2](/d4/4-2-compute-costs/#savings-plans-or-reserved-instances)): you commit to an amount per hour and it applies to whatever database usage runs, so moving from RDS to Aurora, from provisioned to serverless, or to another Region doesn't waste it. They cover serverless options (Aurora Serverless v2, DynamoDB on-demand, ElastiCache Serverless for Valkey) that Reserved Instances can't. The discount varies by service (DynamoDB's is much smaller than 35 %) and is smaller than a Reserved Instance's for the same usage, so for a database that won't change for years, a Reserved Instance can still save more. The two don't stack on the same usage.
- **DynamoDB reserved capacity** only discounts provisioned capacity. A table in on-demand mode, in the Standard-IA table class, or the replicated writes of a global table can't use it.
- **Commit to the baseline only**, after right-sizing: AWS Compute Optimizer and Cost Explorer's recommendations ([Domain 4 overview](/d4/#cost-management-tools)) cover RDS and Aurora, and Cost Explorer shows how much of your Reserved Instances and Savings Plans is used. In an AWS Organizations organisation, these discounts are shared across accounts unless the management account turns sharing off ([Domain 4 overview](/d4/#organising-and-reporting-spend)).

## Aurora: Serverless v2, I/O-Optimized and Standard

| Choice                         | Best when                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Provisioned instances          | Steady, predictable load: size them once and cover them with a Reserved Instance or a Savings Plan                                       |
| Aurora Serverless v2           | Variable, spiky or unknown load, development databases, many small databases: you pay per ACU-hour for the capacity actually used        |
| Aurora Standard (storage)      | Most clusters: storage is cheaper and you pay per million I/O requests                                                                   |
| Aurora I/O-Optimized (storage) | I/O-heavy clusters: no charge for I/O, higher instance and storage prices; AWS suggests it when I/O is more than 25 % of the Aurora bill |

- **Serverless v2 isn't cheaper per hour.** One ACU-hour costs more than the same capacity on a provisioned instance. It saves money when the load is low most of the time and the minimum capacity is set low. For a database that runs near the same capacity all day, a provisioned instance with a commitment costs less.
- **Scaling to zero.** With a minimum of 0 ACUs, an Aurora Serverless v2 instance pauses after a period with no connections and costs nothing for compute while paused (storage still bills). The first connection waits for it to resume, so this fits development and rarely used databases, not production. The usual minimum otherwise is 0.5 ACU.
- **Readers can cost as much as the writer.** Serverless v2 readers in promotion tiers 0 and 1 keep the writer's capacity so they are ready to take over. Put readers that only serve reports in tiers 2–15 so they scale on their own load.
- **Mixed clusters**: a provisioned writer for the steady load with Serverless v2 readers for peaks combines a commitment with pay-per-use.
- **Switching between Standard and I/O-Optimized** is allowed once every 30 days towards I/O-Optimized, and back to Standard at any time.

## DynamoDB: capacity modes and table classes

| Mode        | Billed per                                                                  | Cheapest when                                                                                                 |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| On-demand   | Read and write request units actually used                                  | New, unknown or spiky traffic, tables idle much of the day, or most tables (AWS's default and recommendation) |
| Provisioned | Read and write capacity units per hour, used or not (auto scaling optional) | Steady, predictable traffic that keeps provisioned capacity well used; can add reserved capacity              |

- **On-demand costs nothing when idle** (only storage), but each request costs more than the same work on well-used provisioned capacity. Provisioned capacity with **auto scaling** follows a daily pattern; it reacts in minutes, so a sudden spike can throttle before it catches up.
- **Switching modes.** A table can move from provisioned to on-demand up to four times in 24 hours and back to provisioned at any time.
- **Cap on-demand spend.** An on-demand table can have a **maximum throughput** for reads and writes, so a bug or a traffic surge can't run up the bill.
- **Table classes**: **Standard** for tables where reads and writes cost the most; **Standard-Infrequent Access** cuts the storage price by about 60 % but charges more for reads and writes, so it pays off for tables where storage is the main cost (old orders, logs, history kept for years). The class can change twice in 30 days.
- **Reads cost less when they are eventually consistent** (half the units of a strongly consistent read), and transactional reads and writes cost twice the units. Use strong consistency and transactions only where the application needs them.
- **Smaller items cost less.** Read units count in 4 KB steps and write units in 1 KB steps, so short attribute names, compressed values and large objects kept in S3 (with a pointer in the item) lower every request.
- **Indexes add cost.** Every write to a table also writes to each global secondary index that projects the item. Project only the attributes the queries need, and drop indexes nothing uses.
- **Avoid scans.** A Scan reads, and pays for, the whole table. Design keys and indexes so that reads are queries ([task 3.3](/d3/3-3-databases/#dynamodb-capacity-keys-and-indexes)).
- **TTL deletes expired items for free**, without using write capacity, usually within a few days of expiry, so sessions and temporary data don't keep billing for storage. In a global table, the deletes replicated to other Regions are billed as replicated writes.

## Licences, engines and extended support

The engine itself can be a large part of the bill.

- **Open-source engines** (MySQL, PostgreSQL, MariaDB) and Aurora have no licence fee. MySQL and PostgreSQL cost about the same on RDS; choose between them by what the application and its team need, not by price.
- **Commercial engines**:
  - **RDS for SQL Server** is usually **licence-included**: the licence is in the hourly price. Express has no licence charge (you still pay for the instance); Web, Standard and Enterprise cost more in that order. Customers with Software Assurance can bring their own media and licence instead.
  - **RDS for Oracle** offers licence-included (Standard Edition 2) or **bring your own licence** (BYOL).
  - **RDS for Db2** needs an IBM licence, your own or one through AWS Marketplace. The Community Edition is free.
- **Drop the licence by changing engine.** Moving Oracle or SQL Server to Aurora PostgreSQL or RDS for PostgreSQL removes the licence cost; DMS Schema Conversion converts the schema and code, AWS DMS moves the data ([task 3.3](/d3/3-3-databases/#choosing-a-database)). **Babelfish for Aurora PostgreSQL** understands SQL Server's T-SQL and wire protocol, so a SQL Server application can move with few code changes.
- **A smaller edition** can be enough: SQL Server Standard instead of Enterprise when the application doesn't use Enterprise features. **AWS License Manager** tracks the Oracle and SQL Server licences you bring, so you don't run more than you own.
- **RDS Extended Support** keeps a major version of MySQL or PostgreSQL (in RDS and Aurora) running after its end of standard support, for a fee per vCPU per hour (per ACU-hour for Aurora Serverless v2) that doubles in the third year. Databases are enrolled by default; you can turn enrolment off at creation or later, but turning it off on a version already past standard support upgrades the database to the next supported major version. Upgrading ends the charge.
- **Graviton** instance classes (`db.r7g`, `db.m7g` and others) cost less than comparable x86 classes for the same work on open-source engines and Aurora.

## Non-production and part-time databases

| Need                                            | Cheapest choice                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Development database used in working hours      | Single-AZ, a small or burstable class (`db.t4g`), stopped outside working hours             |
| Development database used now and then          | Aurora Serverless v2 with a minimum of 0 ACUs, or DynamoDB on-demand                        |
| Test copy of a large production Aurora database | **Aurora cloning**: copy-on-write, so the clone's storage grows only with pages that change |
| Database not needed for months                  | Take a snapshot, delete the instance, restore from the snapshot when needed                 |
| Many small databases with uneven load           | Aurora Serverless v2, or several databases on one instance                                  |

- **Stopping an RDS instance or Aurora cluster** stops the instance-hour charges, but storage, provisioned IOPS and backups keep billing. A stopped database starts again by itself after **seven days**, so a schedule has to stop it again: Instance Scheduler on AWS ([task 4.2](/d4/4-2-compute-costs/#non-production-and-part-time-workloads)), or an EventBridge Scheduler schedule that calls the stop API.
- **Snapshot and delete** for a long pause: the snapshot bills only for its storage, which is less than a stopped instance's allocated storage plus IOPS. The restore creates a new instance; give it the old instance's name to keep the same endpoint.
- **Not every database can be stopped**: an RDS instance with read replicas, a read replica itself, RDS for SQL Server in Multi-AZ, and an Aurora cluster in a global database (with other clusters) or with a cross-Region replica can't. Delete what isn't needed instead.
- **Aurora clones** start with almost no extra storage, because they share the source's pages until either side changes them. Each clone still pays for its own instances, and after 15 copy-on-write clones of one source the next clone is a full copy.

## Backups and retention

Backups cost storage, and storage costs every month for as long as it is kept. A retention policy decides how often to back up, how long to keep each copy and where to keep it.

| Service  | Free backup storage                                                                                              | Billed                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| RDS      | Up to 100 % of the total provisioned database storage, per account and Region                                    | Backup storage beyond that; snapshots of deleted instances still count, and deleting an instance lowers the free amount |
| Aurora   | Automated backup up to the cluster volume size, and every snapshot while it is younger than the retention period | Snapshots older than the retention period, every snapshot (at full size) once the cluster is deleted, snapshot copies   |
| DynamoDB | None                                                                                                             | Point-in-time recovery per GB-month of the table, on-demand backups per GB-month, restores                              |

- **Automated backups** allow a point-in-time restore within the retention period (1 to 35 days): RDS takes a daily snapshot plus transaction logs, Aurora backs up continuously (1 day by default). Longer retention means more backup storage. RDS can turn automated backups off (retention 0), Aurora can't.
- **RDS snapshots are incremental**: each one after the first stores only the blocks changed since the previous one, so frequent snapshots of a database that changes little cost little. **Aurora snapshots are full copies**: they are free while younger than the retention period, then billed at the full volume size. To keep Aurora history cheaply, keep fewer, longer-spaced manual snapshots, or export them to S3.
- **Manual snapshots never expire.** They are kept, and billed, until someone deletes them, even after the database is gone. Use **AWS Backup** plans to set how often to back up and how long to keep each recovery point, so old copies are deleted on schedule ([task 2.2](/d2/2-2-high-availability/#backups-and-disaster-recovery)).
- **Long-term retention** for years: DynamoDB backups made with AWS Backup's advanced features can move to **cold storage** ([task 4.1](/d4/4-1-storage-costs/#backup-and-archive)). For RDS and Aurora, **exporting a snapshot to S3** writes the data as Parquet, which can stay in a cheap S3 storage class and be queried with Athena without restoring a database.
- **Copies to other Regions** pay for the transfer and for storage in each Region. Copy only what the recovery plan needs.
- **DynamoDB**: point-in-time recovery keeps 1 to 35 days (35 by default), and a shorter window doesn't lower its price; export to S3 from that window uses no read capacity. Old items can leave the table through TTL, with DynamoDB Streams and Lambda writing them to S3 on the way out.

## Caching and connections

A cache costs money too, so it saves money only when it replaces database capacity you would otherwise pay for.

- **ElastiCache in front of RDS or Aurora** answers repeated reads from memory, so the database can be a smaller instance or have fewer read replicas. It pays off for read-heavy workloads with a good hit rate (the same items read again and again); write-heavy workloads or reads of always-new data gain little. The caching patterns are in [task 2.1](/d2/2-1-scalable-loosely-coupled/#caching-to-take-load-off-the-backend).
- **DAX** caches DynamoDB reads; a read served from DAX uses no read units on the table. For a table with many repeated reads, a small DAX cluster can cost less than the read capacity it replaces.
- **ElastiCache costs**: **Valkey** is priced lower than Redis OSS (serverless and node-based) with the same clients. **Serverless** caches bill a minimum amount of data stored, so a very small, steady cache can be cheaper on one small node. **Data tiering** (node types such as `r6gd`) keeps less-used data on local SSD instead of memory, for large data sets where only a part is hot.
- **Read replica or cache?** A read replica runs the full engine and copies every write; a cache node holds only the hot data. For the same repeated queries, a cache is usually the cheaper way to take reads off the primary. Use replicas when the reads are varied queries that a cache can't answer.
- **RDS Proxy** ([task 3.3](/d3/3-3-databases/#rds-instances-storage-and-read-replicas)) is billed per vCPU of the database instances behind it (per ACU for Aurora Serverless v2). Pooling connections from many short-lived clients, such as Lambda functions, means the database doesn't need a bigger instance just to hold connections. A proxy has a minimum charge, and it keeps an Aurora Serverless v2 cluster from pausing at 0 ACUs.
- **Data transfer**: replication between AZs in one Region for RDS Multi-AZ and read replicas is free; a cross-Region read replica pays for the data sent between Regions, and Aurora Global Database pays for that and for the replicated write I/O ([task 4.4](/d4/4-4-network-costs/)).

## Cheaper database types for the data

The cheapest database is often a different kind of database.

| Data and use                                    | Lower-cost choice                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Key-value lookups, spiky or low traffic         | DynamoDB on-demand instead of an RDS instance that idles                                                          |
| Relational data, steady load                    | RDS or Aurora with a commitment; open-source engines rather than commercial ones                                  |
| Analytics on transactional data                 | Zero-ETL into Amazon Redshift, instead of a bigger production instance                                            |
| Large analytical data sets read by column       | Columnar storage: Redshift, or Parquet files in S3 queried with Athena (billed per data scanned)                  |
| Time series from devices or monitoring          | Amazon Timestream for InfluxDB, instead of a relational table that grows without end                              |
| Old records kept for compliance, rarely queried | S3 (Parquet, a cheap storage class) with Athena, instead of the live database                                     |
| Cassandra or MongoDB clusters run on EC2        | Amazon Keyspaces (billed per request or provisioned capacity) or DocumentDB: no cluster to run and patch yourself |
| Database on EC2 that needs no OS access         | RDS or Aurora: backups, patching and failover without the admin time (RDS Custom only if OS access is needed)     |

- **Columnar formats** store each column together and compress well, so analytical queries read only the columns they need. Athena bills per terabyte scanned: Parquet with partitions can cut the data scanned, and so the bill, to a small part of what a scan of raw CSV or JSON would cost ([task 3.5](/d3/3-5-data-ingestion/#athena-performance)).
- **Keep hot and cold data apart.** The live database holds what the application uses; history moves to S3, where it costs a fraction of database storage.

### Migration costs

- **AWS DMS** bills for the replication instance by the hour (or DMS Serverless capacity units) and its storage; **DMS Schema Conversion** has no extra charge. Data transfer into AWS is free.
- **Very large databases** over a slow link: older exam questions load the initial copy with AWS Snowball Edge, then let DMS replicate the changes since the copy. Snowball Edge is closed to new customers now; AWS points to AWS DataSync or AWS Data Transfer Terminal for large transfers.
- **Delete what the migration left behind**: DMS replication instances, old source instances and their snapshots keep billing.

## If the exam says… → think…

| If the exam says…                                                                 | Think…                                                                                       |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| RDS database runs 24/7 for the next 3 years, lowest cost                          | RDS Reserved Instances (3 years, All Upfront for the most discount)                          |
| Commitment must cover RDS, Aurora and DynamoDB, and the engines may change        | Database Savings Plans                                                                       |
| Relational database with unpredictable or intermittent load, pay for what is used | Aurora Serverless v2                                                                         |
| Development database idle most of the day and at night                            | Aurora Serverless v2 with a minimum of 0 ACUs, or stop it on a schedule                      |
| Aurora cluster where I/O charges are the biggest part of the bill                 | Aurora I/O-Optimized                                                                         |
| Database runs out of space at unpredictable times, without over-provisioning      | RDS storage autoscaling with a maximum storage threshold                                     |
| DynamoDB table with steady, predictable traffic, lowest cost                      | Provisioned capacity with auto scaling, plus reserved capacity                               |
| DynamoDB traffic is new, unknown or very spiky                                    | On-demand capacity mode                                                                      |
| DynamoDB table holds years of data that is rarely read                            | Standard-Infrequent Access table class                                                       |
| Delete expired sessions from DynamoDB without paying for writes                   | TTL                                                                                          |
| Read-heavy relational app, the same queries again and again, cut database cost    | ElastiCache in front of the database, then a smaller instance or fewer replicas              |
| DynamoDB read costs are high from repeated reads of the same items                | DAX                                                                                          |
| Remove Oracle or SQL Server licence costs                                         | Migrate to Aurora PostgreSQL (DMS Schema Conversion + AWS DMS; Babelfish for SQL Server)     |
| Old MySQL or PostgreSQL version suddenly costs more                               | RDS Extended Support charges: upgrade to a supported major version                           |
| Test copies of a large production Aurora database, cheaply                        | Aurora cloning                                                                               |
| RDS database not needed for several months                                        | Snapshot it and delete the instance; restore later                                           |
| Development RDS instances used only in working hours                              | Stop them on a schedule (Instance Scheduler on AWS); they restart by themselves after 7 days |
| Backups must be kept for 7 years at the lowest cost                               | AWS Backup with retention rules (cold storage where supported), or snapshot export to S3     |
| Manual snapshots pile up and the backup bill grows                                | AWS Backup plans with retention, delete old manual snapshots                                 |
| Analytical queries over years of data, pay per query                              | Parquet in S3 with Athena                                                                    |
| Many Lambda functions open connections to RDS                                     | RDS Proxy, instead of a bigger instance                                                      |

## Common traps

- **A stopped RDS instance still pays** for storage and backups, and starts again by itself after seven days.
- **RDS storage can't shrink.** Storage autoscaling only grows the volume; set a maximum.
- **Reserved Instances only cover instance hours**: storage, I/O, backups and data transfer are billed as usual. They also bill when the instance is stopped or deleted.
- **Aurora Serverless v2 isn't always cheaper.** For a steady load, provisioned instances with a commitment cost less.
- **Multi-AZ doubles the instance cost.** Leave it off in development and test, not in production.
- **Read replicas cost a full instance each.** A cache may take the same reads off the primary for less.
- **DynamoDB reserved capacity doesn't apply** to on-demand tables or to the Standard-IA table class.
- **Standard-IA isn't for busy tables.** Its reads and writes cost more; it saves only when storage dominates.
- **Strongly consistent reads and transactions cost double.** Use them only where needed.
- **Manual snapshots stay until deleted**, even after the database is deleted.
- **Aurora snapshots aren't incremental.** Each one kept beyond the retention period bills for the full volume size.
- **RDS Proxy stops Aurora Serverless v2 from pausing.** A cluster meant to scale to 0 ACUs can't while a proxy is attached.
- **Licence-included isn't free.** Commercial engines carry the licence in the hourly price; open-source engines and Aurora don't.
- **Extended Support is charged automatically** for old major versions until you upgrade (or turn enrolment off, which upgrades a version already past standard support).
- **Data transfer between Regions isn't free.** Cross-Region replicas and backup copies pay for it.

## Links

**AWS documentation**

- [Amazon RDS storage autoscaling](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIOPS.Autoscaling.html) and [Amazon RDS pricing](https://aws.amazon.com/rds/pricing/)
- [Reserved DB instances for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithReservedDBInstances.html) and [Savings Plans types](https://docs.aws.amazon.com/savingsplans/latest/userguide/plan-types.html)
- [Aurora Serverless v2](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html) and [Aurora storage configurations](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Overview.StorageReliability.html#aurora-storage-type)
- [Stopping an Amazon RDS DB instance temporarily](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html) and [Amazon RDS Extended Support](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/extended-support.html)
- [DynamoDB capacity modes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/capacity-mode.html), [table classes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.TableClasses.html) and [cost optimization best practices](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-cost-optimization.html)
- [Backing up and restoring RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_CommonTasks.BackupRestore.html) and [exporting snapshot data to S3](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ExportSnapshot.html)
- [Amazon ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/) and [Amazon RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)

**Practice**

- [Practice tests](/practice/): in the **Practice** card, choose **Practice by: Task** and then **4.3** to drill only this task.
