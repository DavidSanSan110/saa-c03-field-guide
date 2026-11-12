---
title: 'Task 3.3: Determine high-performing database solutions'
description: 'Choosing a purpose-built database, engine migrations with DMS, RDS instance and storage sizing, read replicas and RDS Proxy, Aurora storage, endpoints, replica auto scaling and Aurora Serverless v2, DynamoDB capacity modes, partition key design, indexes and DAX, and ElastiCache and MemoryDB, with exam cues and common traps.'
---

Database questions in this task describe how an application uses its data (a reporting job slowing down the orders database, thousands of Lambda functions opening connections, a game that reads a player's profile millions of times a minute) and ask which database, or which feature of it, keeps up. Start from the **data model and access pattern**: relational with joins and transactions, key-value lookups at any scale, documents, graphs, time series. That picks the engine. Then find the **bottleneck**: reads, writes, connections or latency, and pick the feature that removes it. Failover and backups are in [task 2.2](/d2/2-2-high-availability/); lowering the bill is task 4.3.

Part of [Domain 3: Design High-Performing Architectures](/d3/).

## Choosing a database

| Data model              | Service                             | Pick it for                                                                                                       |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Relational              | Amazon RDS, Amazon Aurora           | SQL, joins, transactions, a fixed schema: orders, accounts, ERP and CRM systems                                   |
| Key-value and document  | Amazon DynamoDB                     | Known access patterns at any scale with single-digit millisecond latency: carts, profiles, sessions               |
| In-memory               | Amazon ElastiCache, Amazon MemoryDB | Microsecond reads: a cache in front of a database, leaderboards, sessions (MemoryDB also as the primary database) |
| Document (MongoDB API)  | Amazon DocumentDB                   | JSON documents queried in flexible ways, moving a MongoDB workload without rewriting it                           |
| Wide column (Cassandra) | Amazon Keyspaces                    | Cassandra applications using CQL, without managing the cluster                                                    |
| Graph                   | Amazon Neptune                      | Highly connected data: social networks, fraud rings, recommendations, knowledge graphs                            |
| Time series             | Amazon Timestream for InfluxDB      | Measurements over time from IoT devices, applications and operations, with time-based queries                     |
| Search                  | Amazon OpenSearch Service           | Full-text search, log analytics, relevance ranking                                                                |
| Data warehouse          | Amazon Redshift                     | Analytical SQL over large data sets (task 3.5)                                                                    |

- **Relational or not?** Joins, complex queries and multi-row transactions point to RDS or Aurora. Simple lookups by key with a predictable, very high request rate, or a schema that changes often, point to DynamoDB.
- **Managed or self-managed?** RDS and Aurora handle provisioning, patching, backups and replicas; you don't get the OS. **RDS Custom** (Oracle and SQL Server) gives OS and database access for software that needs it; a database on EC2 is the last resort.
- **Moving to a new engine.** **AWS DMS** copies the data and can keep replicating changes until the cut-over, so downtime stays short. A **homogeneous** migration (MySQL to RDS for MySQL or Aurora MySQL) needs only DMS or the engine's native tools. A **heterogeneous** one (Oracle or SQL Server to Aurora PostgreSQL) first converts the schema and code with **DMS Schema Conversion** (or the downloadable AWS Schema Conversion Tool); it converts the schema, not the data.
- **Amazon QLDB**, the ledger database, reached end of support on 31 July 2025; AWS points ledger use cases to Aurora PostgreSQL.
- **Amazon Timestream for LiveAnalytics** closed to new customers in June 2025; AWS recommends **Timestream for InfluxDB** for new time-series workloads.

## RDS: instances, storage and read replicas

**Amazon RDS** runs MySQL, PostgreSQL, MariaDB, Oracle, SQL Server and Db2 on an instance class you choose, with EBS storage.

- **Instance class**: memory-optimised classes (`db.r*`, `db.x*`) keep more of the working set in memory, which matters most for read performance; general purpose (`db.m*`) suits balanced loads, and burstable (`db.t*`) only dev, test and small loads. Changing the class is a vertical scale with a short outage (minimised with Multi-AZ).
- **Storage**: General Purpose SSD (gp3) for most databases, **Provisioned IOPS** (io2 Block Express) for I/O-heavy OLTP that needs steady, sub-millisecond latency. **Storage autoscaling** grows the volume when free space runs low, up to a maximum you set; storage can't shrink.
- **RDS Optimized Reads** (MySQL, MariaDB and PostgreSQL on classes with local NVMe, such as `db.r6gd`) puts temporary tables on the local NVMe, for faster complex queries. **RDS Optimized Writes** (MySQL and MariaDB on Nitro classes) writes each page once, without the doublewrite buffer, for up to twice the write throughput.
- **Read replicas** copy the data asynchronously to up to 15 read-only instances (3 for Db2), in the same AZ, another AZ or another Region. Reports and other heavy readers go to a replica instead of the primary. The application must send reads to the replica's own endpoint, and reads can be slightly behind. RDS doesn't add replicas automatically; only Aurora has replica auto scaling.
- **Multi-AZ DB clusters** (MySQL and PostgreSQL) have two readable standbys, so they add read capacity as well as availability; the standby of a Multi-AZ DB instance serves no reads.
- **Performance monitoring**: CloudWatch Database Insights (which includes Performance Insights) shows which queries and waits load the database, so you fix the query before buying a bigger instance.

**RDS Proxy** keeps a pool of connections to RDS (MySQL, MariaDB, PostgreSQL, SQL Server) or Aurora and shares it among many clients. It suits applications that open many short connections, above all Lambda functions: the database sees a few long-lived connections instead of thousands. It runs in your VPC across AZs, is never public, can require IAM authentication from clients while it reaches the database with Secrets Manager credentials or IAM database authentication, and keeps client connections open during a failover.

## Aurora: storage, endpoints and Serverless v2

**Amazon Aurora** is compatible with MySQL and PostgreSQL but separates compute from storage. The cluster volume keeps six copies of the data across three AZs and grows by itself, up to 256 TiB in current versions; every instance in the cluster reads the same volume.

| Endpoint         | Points to                                    | Use it for                                                             |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| Cluster (writer) | The current primary instance                 | All writes, and reads that must see the latest write                   |
| Reader           | All Aurora Replicas, with connections spread | Read-only traffic that can scale out                                   |
| Custom           | A set of instances you choose                | Separating workloads: analytics on large replicas, the app on the rest |
| Instance         | One specific instance                        | Diagnostics and tuning; rarely right for the application               |

- **Aurora Replicas** (up to 15) read the shared volume, so replica lag is usually under 100 milliseconds, far less than RDS read replicas. **Replica auto scaling** adds and removes replicas on CPU or connections and registers them with the reader endpoint.
- **Aurora Serverless v2** (now just "Aurora Serverless" in the docs; v1 is retired) scales each instance's capacity in fine steps, measured in Aurora capacity units (ACUs, about 2 GiB of memory each), from a minimum to a maximum you set (up to 256 ACUs), in place and within seconds. It suits variable or unpredictable loads, and it mixes with provisioned instances in one cluster. Recent versions can pause at 0 ACUs when idle; the first connection then waits for the instance to resume (about 15 seconds).
- **Aurora Global Database** gives up to 10 other Regions read-only copies with lag typically under a second, for low-latency reads near users; **write forwarding** lets applications in those Regions send writes, which the primary Region applies (failover is in task 2.2).
- **Zero-ETL integrations** replicate Aurora and RDS data into Amazon Redshift in near real time, so analytics run there instead of on the transactional database.
- **Other speed features**: **cloning** creates a copy of a cluster in minutes with copy-on-write, so a test or reporting copy doesn't slow production; **Aurora PostgreSQL Limitless Database** shards writes across many instances for loads one writer can't handle.
- **Amazon Aurora DSQL** is a separate, serverless distributed SQL database (PostgreSQL-compatible) that is active-active across Regions, for applications that need SQL writes in several Regions.

## DynamoDB: capacity, keys and indexes

**Amazon DynamoDB** stores items (up to 400 KB each; larger objects go to S3 with a pointer in the item) in tables, identified by a **partition key** and, optionally, a **sort key**. It is serverless, replicates across three AZs, and keeps single-digit millisecond latency at any size, as long as requests are spread over many partition key values.

| Capacity mode | How it works                                                                                         | Pick it for                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| On-demand     | No capacity to plan; scales with traffic and bills per request. The default and AWS's recommendation | New, unknown or spiky traffic; tables idle most of the time |
| Provisioned   | You set read and write capacity units, optionally with auto scaling between a minimum and maximum    | Steady, predictable traffic, where it costs less            |

- **Capacity units**: one **RCU** is one strongly consistent read per second of an item up to 4 KB, or two eventually consistent reads; one **WCU** is one write per second of up to 1 KB. Transactional reads and writes cost twice as much. Larger items use more units.
- **Partition key design** decides performance. Each partition handles at most 3,000 read units and 1,000 write units per second, so a key with few values (a status, today's date) creates a **hot partition** and throttling even when the table has capacity left. Use a high-cardinality key (user ID, order ID), and for a very hot key add a random or calculated suffix (**write sharding**). Adaptive capacity moves capacity to busy partitions, and burst capacity keeps up to 300 seconds of unused capacity for short spikes, but neither can beat the per-partition limit.
- **Warm throughput** shows how much the table can take at once; it can be raised in advance (pre-warming, charged, and it can't be lowered again) for a launch or a planned peak.
- **Reads**: eventually consistent by default; strongly consistent reads cost double and aren't available on global secondary indexes. **Query** reads one partition key; **Scan** reads the whole table and is slow and expensive on large tables.

| Index                        | Keys                                     | Created             | Consistency                |
| ---------------------------- | ---------------------------------------- | ------------------- | -------------------------- |
| Global secondary index (GSI) | Any partition key, optional sort key     | Any time            | Eventually consistent only |
| Local secondary index (LSI)  | Same partition key, a different sort key | Only with the table | Eventual or strong         |

- A table has up to 20 GSIs (a quota you can raise) and 5 LSIs. With an LSI, all items that share a partition key value must fit in 10 GB.
- **DAX** (DynamoDB Accelerator) is an in-memory cache cluster in your VPC that speaks the DynamoDB API, so an application switches to it with a client change, not new code. Cached reads take microseconds instead of milliseconds. It caches items and query results, writes through to the table, and serves eventually consistent reads only (strongly consistent reads pass through to the table). It suits read-heavy tables with repeated reads of the same items, not write-heavy ones.
- **DynamoDB Streams** and Lambda for reacting to changes are in [task 2.1](/d2/2-1-scalable-loosely-coupled/); **global tables** for multi-Region reads and writes are in [task 2.2](/d2/2-2-high-availability/). **TTL** deletes expired items in the background, within a few days of expiry, without using write capacity.

## ElastiCache and MemoryDB

**Amazon ElastiCache** is a managed in-memory store in front of a database, for microsecond reads. It needs application code: your application decides what to read from the cache and what to write to it (lazy loading and write-through are in [task 2.1](/d2/2-1-scalable-loosely-coupled/)).

| Engine              | Data types                                                     | Scaling and availability                                                         | Pick it for                                                        |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Valkey or Redis OSS | Strings, hashes, lists, sets, sorted sets, streams, geospatial | Replicas for reads and failover, Multi-AZ, backups; cluster mode shards the data | Most caches, sessions, leaderboards (sorted sets), pub/sub, queues |
| Memcached           | Simple keys and values                                         | Several nodes share the data; no replication, no persistence (node-based)        | The simplest cache, multi-threaded nodes, data you can lose        |

- **Valkey** is the open-source fork of Redis OSS that AWS recommends for new caches; it is compatible with Redis OSS clients and costs less.
- **Serverless** caches scale by themselves with no nodes to size; **node-based** clusters let you choose node types and shard counts.
- **Cluster mode** (Valkey or Redis OSS) splits the keys across shards, each with its own primary, so both writes and memory scale out; with it off, one primary takes all writes.
- **Amazon MemoryDB** is a durable, Valkey- and Redis OSS-compatible **database**: writes are stored in a Multi-AZ transaction log, so the data survives node failures. Use it when in-memory speed is needed for the primary copy of the data, not just a cache. (Node-based ElastiCache for Valkey 9.0 and later can now turn on durability too, but MemoryDB is the usual exam answer.)

## If the exam says… → think…

| If the exam says…                                                           | Think…                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Reporting queries slow down the production database                         | Read replica (Aurora: a reader or custom endpoint) for reports              |
| Thousands of Lambda functions exhaust database connections                  | RDS Proxy                                                                   |
| Read-heavy app, the same queries again and again                            | ElastiCache in front of the database (lazy loading)                         |
| DynamoDB reads need microsecond latency without rewriting the app           | DAX                                                                         |
| DynamoDB throttles although the table has unused capacity                   | Hot partition: a higher-cardinality key or write sharding                   |
| DynamoDB traffic is new, unpredictable or very spiky                        | On-demand capacity mode                                                     |
| Query DynamoDB by an attribute that isn't the key, after the table exists   | Global secondary index                                                      |
| Relational database with unpredictable or intermittent load                 | Aurora Serverless v2                                                        |
| Aurora replicas must scale with read load                                   | Aurora replica auto scaling behind the reader endpoint                      |
| Analytics and the app must use different Aurora replicas                    | Custom endpoints                                                            |
| A test copy of a large Aurora database, fast and without slowing production | Aurora cloning                                                              |
| Readers in other Regions need low-latency reads of one relational database  | Aurora Global Database                                                      |
| RDS needs steady, very high IOPS                                            | Provisioned IOPS (io2 Block Express) storage                                |
| The database runs out of disk space at unpredictable times                  | RDS storage autoscaling                                                     |
| Gaming leaderboard ranked in real time                                      | ElastiCache (Valkey or Redis OSS) sorted sets                               |
| Cache with replication, failover and backups                                | Valkey or Redis OSS, not Memcached                                          |
| In-memory speed for data that must not be lost                              | Amazon MemoryDB                                                             |
| Move MongoDB to a managed service without rewriting the app                 | Amazon DocumentDB                                                           |
| Social network, fraud rings, relationships between entities                 | Amazon Neptune                                                              |
| IoT sensor readings queried over time windows                               | Amazon Timestream for InfluxDB                                              |
| Cassandra workload without managing the cluster                             | Amazon Keyspaces                                                            |
| Full-text search over product descriptions                                  | Amazon OpenSearch Service                                                   |
| Oracle to Aurora PostgreSQL with minimal downtime                           | DMS Schema Conversion for the schema, then AWS DMS with ongoing replication |
| Database software needs OS access (Oracle, SQL Server)                      | RDS Custom                                                                  |

## Common traps

- **Read replicas don't help writes.** Write bottlenecks need a bigger instance, sharding (Aurora Limitless Database) or DynamoDB.
- **RDS read replicas are asynchronous.** A read right after a write can miss it; reads that must be current go to the primary.
- **Multi-AZ DB instance standbys don't serve reads** ([task 2.2](/d2/2-2-high-availability/)); for readable standbys use a Multi-AZ DB cluster or Aurora.
- **The application has to use the replicas.** RDS read replicas and Aurora readers need their own endpoint in the connection settings.
- **ElastiCache needs code changes**; DAX needs only a client change and works only with DynamoDB.
- **DAX doesn't speed up writes** or strongly consistent reads.
- **Node-based Memcached has no replicas, no failover and no persistence.**
- **RDS read replicas don't scale themselves.** Automatic replica scaling is an Aurora feature.
- **A cache isn't a database.** Data that must survive goes to MemoryDB or a real database, not a plain ElastiCache cache.
- **A low-cardinality partition key throttles DynamoDB** however much capacity the table has.
- **Scans are slow on large tables.** Design keys and indexes so that reads are queries.
- **LSIs can only be created with the table**; a new access pattern later needs a GSI.
- **GSIs don't support strongly consistent reads.**
- **Storage autoscaling only grows.** RDS storage can't shrink.

## Links

**AWS documentation**

- [Choosing an AWS database service](https://docs.aws.amazon.com/decision-guides/latest/databases-on-aws-how-to-choose/databases-on-aws-how-to-choose.html)
- [Amazon RDS DB instance classes](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.html), [storage](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html) and [read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html)
- [Amazon RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html) and [What is AWS DMS?](https://docs.aws.amazon.com/dms/latest/userguide/Welcome.html)
- [Amazon Aurora endpoints](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Overview.Endpoints.html), [Aurora Replicas](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Replication.html) and [Aurora Serverless v2](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html)
- [DynamoDB capacity modes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/capacity-mode.html) and [partition key design](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)
- [DynamoDB secondary indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/SecondaryIndexes.html) and [DynamoDB Accelerator (DAX)](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DAX.html)
- [Choosing an ElastiCache engine](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/SelectEngine.html) and [What is Amazon MemoryDB?](https://docs.aws.amazon.com/memorydb/latest/devguide/what-is-memorydb.html)

**Practice**

- [Practice tests](/practice/): in the **Practice** card, choose **Practice by: Task** and then **3.3** to drill only this task.
