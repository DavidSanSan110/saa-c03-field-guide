---
title: 'Task 3.5: Determine high-performing data ingestion and transformation solutions'
description: 'Batch and streaming ingestion and how to size and secure it, Kinesis Data Streams, Amazon MSK and Managed Service for Apache Flink, transformation and format conversion in Data Firehose, an S3 data lake with the Glue Data Catalog, crawlers and Lake Formation permissions, Glue ETL and DataBrew, Athena performance (partitions, columnar formats, file sizes), Redshift, EMR and OpenSearch, Quick Sight (QuickSight), the AI services that turn documents, images and speech into data, and DMS, zero-ETL and AppFlow for loading data, with exam cues and common traps.'
---

Questions in this task describe data on its way in (clicks from a mobile app, CSV exports from a partner every night, an on-premises database whose changes must reach the analysts within minutes) and ask how to get it into AWS, reshape it and query it fast. Follow the data along the pipeline. **Ingest**: how often does it arrive, how much, and how soon must it be usable? **Store**: an S3 data lake, catalogued so every engine can find it. **Transform**: clean it and convert it to a columnar format. **Analyse**: the engine that matches the query (Athena, Redshift, EMR, OpenSearch). **Visualise**: Quick Sight (formerly QuickSight). The basics of Kinesis Data Streams, Data Firehose, SQS and SNS are in [task 2.1](/d2/2-1-scalable-loosely-coupled/), file transfers (DataSync, Transfer Family, Storage Gateway, offline transfer) in [task 3.1](/d3/3-1-storage/), engine migrations with DMS in [task 3.3](/d3/3-3-databases/), and analytics costs in [Domain 4](/d4/).

Part of [Domain 3: Design High-Performing Architectures](/d3/).

## Ingestion patterns: frequency, size and speed

| Pattern                  | Example                                                           | Service                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| One-time bulk copy       | A 400 TB archive moving from a data centre to S3                  | DataSync, or an offline transfer: Data Transfer Terminal (Snowball Edge in older questions), [task 3.1](/d3/3-1-storage/) |
| Files on a schedule      | Nightly exports from a NAS, partners uploading files over SFTP    | DataSync tasks, Transfer Family, uploads to S3 ([task 3.1](/d3/3-1-storage/))                                             |
| Database changes         | Every new order in an Oracle database, in the lake within minutes | DMS full load plus change data capture (CDC), or a zero-ETL integration into Redshift                                     |
| SaaS applications        | Records from Salesforce, ServiceNow or Zendesk                    | Amazon AppFlow                                                                                                            |
| Streams of small records | Clicks, application logs, metrics                                 | Kinesis Data Streams, Amazon Data Firehose, Amazon MSK                                                                    |
| Third-party data sets    | Weather or market data bought from a provider                     | AWS Data Exchange: subscribe to the data and export it to S3                                                              |
| Video from cameras       | Security cameras in every shop                                    | Amazon Kinesis Video Streams, which stores the video for playback and analysis                                            |
| Device messages          | Sensors publishing over MQTT                                      | AWS IoT Core, whose rules forward messages to Kinesis, Firehose, S3 and other services                                    |

- **Real time or near real time?** Milliseconds, several consumers or replay: Kinesis Data Streams or MSK. Near real time is fine (Firehose buffers for 0 to 900 seconds before each delivery) and the data only has to land in S3, Redshift or OpenSearch: Data Firehose, with no consumer code. The comparison is in [task 2.1](/d2/2-1-scalable-loosely-coupled/).
- **Size the stream from the numbers.** A provisioned Kinesis shard takes 1 MB/s or 1,000 records/s of writes, whichever comes first. 4,000 records/s of 3 KB each is 12 MB/s, so the stream needs at least 12 shards; 4,000 records/s of 100 bytes needs only 4. Reads are 2 MB/s per shard, shared by all standard consumers (enhanced fan-out is in [task 2.1](/d2/2-1-scalable-loosely-coupled/)). A partition key with few values sends most records to one shard (a **hot shard**), which throttles even when other shards have capacity: use a key with many values, such as a device or user ID. **On-demand mode** adds and removes shards for you, for traffic you can't predict.
- **Size the transfer from the bandwidth.** Bandwidth is in bits: 100 TB is 800,000 gigabits, so a fully used 1 Gbps link needs more than nine days. A one-time copy that the network can't finish by the deadline is an offline transfer, covered in [task 3.1](/d3/3-1-storage/).
- **Write in batches.** `PutRecords` sends up to 500 records per call, and the Kinesis Producer Library adds batching, aggregation and retries. Redshift loads fastest with `COPY` from S3, not row-by-row `INSERT`s. Firehose buffers records into larger objects, which is also what Athena reads best.

## Securing the ingestion points

Encryption keys and S3 bucket policies are in [task 1.3](/d1/1-3-data-security/), and VPC endpoints in [task 1.2](/d1/1-2-secure-workloads/). For ingestion, the questions are about who may write, and over which path.

- **Least privilege for producers**: a producer's role allows only `kinesis:PutRecord` and `kinesis:PutRecords` (or `firehose:PutRecord` and `firehose:PutRecordBatch`) on its own stream. Applications on AWS use IAM roles, not access keys; mobile and web clients get temporary credentials from an Amazon Cognito identity pool.
- **Keep the traffic private**: interface VPC endpoints (PrivateLink) reach Kinesis Data Streams, Data Firehose, Glue, Athena and Redshift without an internet gateway, and a gateway endpoint reaches S3. A bucket policy can then accept writes only through that endpoint (`aws:SourceVpce`).
- **Encrypt in transit and at rest**: the Kinesis and Firehose APIs use TLS. Kinesis Data Streams server-side encryption with a KMS key is a setting you turn on; MSK always encrypts data at rest and uses TLS between brokers and clients by default.
- **Amazon MSK** brokers run in your VPC's subnets behind security groups. Clients of a provisioned cluster authenticate with IAM access control, SASL/SCRAM (credentials stored in Secrets Manager) or mutual TLS; MSK Serverless accepts IAM access control only.
- **File endpoints**: a Transfer Family server can sit in a VPC with security groups and Elastic IP addresses, and authenticate users with SSH keys or a custom identity provider. Browsers and mobile apps can upload straight to S3 with **presigned URLs**, with no AWS credentials on the client.
- **The lake itself**: S3 Block Public Access on, default encryption, and access to tables granted through Lake Formation instead of broad S3 permissions (see below).

## Streaming: Kinesis Data Streams, Amazon MSK and Apache Flink

|             | Kinesis Data Streams                                                    | Amazon MSK                                                                               |
| ----------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| What it is  | A serverless AWS streaming service, used through the Kinesis API        | Managed Apache Kafka clusters, used through the open-source Kafka APIs                   |
| Scales by   | Shards (provisioned) or automatically (on-demand)                       | Brokers and partitions (provisioned), or automatically with MSK Serverless               |
| Record size | 1 MiB by default; up to 10 MiB per stream, for occasional large records | 1 MB by default, configurable higher (up to 8 MiB on MSK Serverless)                     |
| Retention   | 24 hours by default, up to 365 days                                     | Whatever you configure; tiered storage keeps older data at a lower cost                  |
| Network     | An AWS public endpoint, or an interface VPC endpoint                    | Brokers in your VPC subnets                                                              |
| Pick it for | New streaming applications with the least to manage                     | Existing Kafka applications and tools, Kafka Connect connectors, Kafka-specific features |

- **MSK Connect** runs Kafka Connect connectors on managed capacity, for example to copy topics into S3 or out of a database. **Express brokers** on provisioned clusters scale faster and take more throughput per broker than standard brokers.
- **Amazon Managed Service for Apache Flink** (formerly Kinesis Data Analytics) runs Apache Flink applications in Java, Scala, Python or SQL, usually reading from Kinesis Data Streams or MSK. Use it for **stateful** processing in real time: aggregations over time windows, joins between streams, anomaly detection. It scales the application and takes snapshots of its state.
- **Firehose has no read API**, so Flink, Lambda and your own consumers can't read from it. Firehose is the last step that delivers data; a stream that must also be processed goes into Kinesis Data Streams or MSK first.
- **Lambda** with an event source mapping processes batches of records from Kinesis or MSK: good for filtering, enriching or routing each record. For state kept across many records, use Flink.
- **AWS Glue streaming ETL** jobs run Spark Structured Streaming on Kinesis, MSK or Kafka, for teams that already write Spark.

### Transforming data in Data Firehose

- **Lambda transformation**: Firehose sends each buffered batch to a function that can reshape, filter or enrich the records before delivery.
- **Record format conversion** turns JSON records into **Apache Parquet** or **Apache ORC**, using the schema of a table in the Glue Data Catalog. The input must be JSON: CSV or log lines go through a Lambda transformation to JSON first.
- **Dynamic partitioning** writes records to S3 prefixes built from keys inside the data (`customer_id=42/year=2026/month=11/`), so later queries read only the partitions they need.
- **Compression** for S3 delivery: GZIP, Snappy, ZIP or Hadoop-compatible Snappy (Athena can't read ZIP). Records that fail go to an S3 error prefix.
- **Destinations**: S3 (including Apache Iceberg tables), Redshift (Firehose writes to S3 and then runs `COPY`), OpenSearch, HTTP endpoints and partners such as Splunk and Snowflake. **Sources**: direct `PUT` from producers, a Kinesis data stream, an MSK topic, CloudWatch Logs subscription filters, IoT rules and more.

## The S3 data lake: Glue Data Catalog and crawlers

A **data lake** keeps all data in S3 in open formats, separate from the engines that read it: Athena, Redshift Spectrum, EMR and Glue can all query the same files. Data usually moves through zones: **raw** (as it arrived), **processed** (cleaned, converted to Parquet) and **curated** (joined and aggregated for analysts), often in separate prefixes or buckets.

- The **AWS Glue Data Catalog** holds the metadata: databases and tables with their columns, format, S3 location and partitions. There is one catalog per account and Region, compatible with the Apache Hive metastore, and Athena, Redshift Spectrum, EMR, Glue jobs, Firehose format conversion and Lake Formation all use it.
- A **crawler** connects to a data store (S3, JDBC databases, DynamoDB and others), infers the schema with classifiers, and creates or updates tables and their partitions. Run it on a schedule or on demand. To avoid crawling everything again, crawl only new folders, or use S3 event notifications so the crawler reads only the objects that changed.
- **New partitions without a crawler**: Athena's `ALTER TABLE ADD PARTITION`, `MSCK REPAIR TABLE`, or **partition projection** (see Athena below).
- **Open table formats** such as **Apache Iceberg** add database features to files in S3: ACID transactions, row-level updates and deletes, schema changes and time travel queries. Athena, EMR, Glue, Redshift and Firehose work with Iceberg tables. **Amazon S3 Tables** store Iceberg tables in table buckets and compact small files automatically.

### Lake Formation: permissions for the whole lake

Without Lake Formation, access is set in many places: bucket policies, IAM policies for each engine, Quick Sight settings. **AWS Lake Formation** builds on the Glue Data Catalog and manages access in one place.

- **Register** the S3 locations of the lake with Lake Formation. Then **grant** permissions on databases, tables and columns to IAM users and roles, IAM Identity Center users and groups, and other AWS accounts.
- **Fine-grained access**: column-level permissions, and **data filters** for row-level and cell-level security (only rows where `country = 'ES'`, without the salary column).
- **LF-Tags** (tag-based access control) attach tags such as `confidentiality=private` to databases, tables and columns, and grant by tag, so new tables are covered without new grants.
- Integrated engines (Athena, Redshift Spectrum, EMR, Glue) check the grants and receive temporary credentials for only the data allowed, so users don't need S3 permissions of their own.
- **Lake Formation grants take effect** only after the default `IAMAllowedPrincipals` grant (which leaves access to IAM policies) is revoked for a resource, or the resource and principals are opted in to **hybrid access mode**.
- **Cross-account sharing** of databases and tables goes through AWS RAM, without copying data.

## Transforming data with AWS Glue

**AWS Glue** is serverless ETL. You pay for the job's run time and don't manage a cluster.

- **ETL jobs** run Apache Spark (Python or Scala) for large data, or a Python shell for small tasks. Capacity is set in workers (DPUs); **auto scaling** adds and removes workers during a run. The **Flex** execution class runs jobs that aren't urgent on spare capacity at a lower price.
- **Glue Studio** builds jobs in a visual editor and generates the code. **Glue DataBrew** is visual, no-code data preparation for analysts, with hundreds of ready-made transformations for cleaning and normalising data.
- **Job bookmarks** remember what earlier runs processed, so each run reads only new data.
- **Triggers and workflows** run crawlers and jobs on a schedule, on demand or when other jobs finish; EventBridge events (such as new objects in S3) can start a workflow. Larger pipelines are orchestrated with Step Functions. **AWS Data Pipeline**, the older service for scheduled data movement, is closed to new customers; its jobs move to Glue or Step Functions.
- **Glue Data Quality** checks data against rules you write and can stop a job when the data is bad.

### Converting between formats

Converting CSV or JSON to **Parquet** or **ORC** is the most common transformation in this task: queries then read only the columns they need. Choose the tool by where the data is.

| Where the data is                        | Convert it with                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A stream on its way to S3                | Firehose record format conversion (JSON input; a Lambda transformation turns CSV into JSON first)    |
| Files already in S3, as new files arrive | A Glue ETL job, started by a schedule, an S3 event through EventBridge, or a workflow                |
| Files in S3, as a one-off with SQL       | Athena `CREATE TABLE AS SELECT` (CTAS) `WITH (format = 'PARQUET')`, or `INSERT INTO` a Parquet table |
| Very large data or custom processing     | Spark on EMR                                                                                         |
| A relational database                    | DMS with an S3 target that writes Parquet                                                            |

## Querying the data: Athena, Redshift, EMR and OpenSearch

| Service            | What it is                                                               | Pick it for                                                                             |
| ------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Amazon Athena      | Serverless SQL on files in S3, with tables from the Glue Data Catalog    | Ad hoc queries on the lake and on logs (CloudTrail, VPC Flow Logs, ALB), nothing to run |
| Amazon Redshift    | A columnar, massively parallel data warehouse, provisioned or Serverless | Fast, repeated BI queries, complex joins and aggregations, many concurrent users        |
| Amazon EMR         | Managed big data frameworks on EC2, on EKS or serverless                 | Large custom processing with Spark, Hive, Presto, Trino, HBase or Flink                 |
| OpenSearch Service | A search and analytics engine with OpenSearch Dashboards                 | Full-text search, log and clickstream analytics, near real-time dashboards              |

### Athena performance

Athena charges for the data each query scans, so the changes that make it faster also make it cheaper.

- **Partition** the data by the columns most queries filter on, usually date, in Hive-style prefixes (`s3://logs/year=2026/month=11/day=12/`). A query with `WHERE year = '2026' AND month = '11'` then reads only those prefixes. Too many small partitions slow planning down, so don't partition by a column with millions of values.
- **Partition projection** computes the partitions from rules in the table properties instead of looking them up in the Data Catalog. Queries on heavily partitioned tables plan faster, and new partitions (one per hour, say) need no crawler or `ADD PARTITION`.
- **Columnar formats**: with **Parquet** or **ORC**, Athena reads only the columns in the query and skips blocks whose minimum and maximum values can't match the filter. On wide tables this cuts the data scanned many times over.
- **Compression** (Snappy, ZSTD, GZIP) means less data to read. Prefer formats that can be split, so several readers work on one file in parallel: Parquet and ORC are splittable with any of their codecs, while a large GZIP-compressed CSV is read by one reader.
- **File sizes**: thousands of tiny files are slow, because every file costs a request and some overhead. AWS suggests splits of around 128 MB, so aim for files of that size or larger, and compact small files with a Glue job, CTAS, or Iceberg's `OPTIMIZE`.
- **Write better SQL**: select only the columns you need instead of `SELECT *`, filter on partition columns, and use `approx_distinct` when an exact count isn't needed.
- **Workgroups** separate teams and workloads: each has its own result location, limits on data scanned per query, and metrics. **Capacity reservations** give a workgroup dedicated query capacity for steady concurrency, and **query result reuse** returns a recent result for a repeated query without scanning again.
- **Federated queries** use data source connectors (traditionally Lambda functions) to query DynamoDB, RDS, Redshift, CloudWatch Logs, on-premises databases and more, and join them with data in S3, without moving the data first.

### Data warehousing with Redshift

**Amazon Redshift** stores data by column, compresses it and spreads each query across nodes: a **leader node** plans the query and **compute nodes** run it in parallel. **RA3** nodes keep data in Redshift managed storage, so compute and storage scale separately. **Redshift Serverless** sizes capacity (in RPUs) automatically and bills compute per second only while it works (storage is billed separately).

- **Loading**: `COPY` from S3 loads many files in parallel, so split large loads into several files of similar size. Firehose loads through S3 and `COPY`. **Zero-ETL integrations** replicate Aurora, RDS and DynamoDB data into Redshift with no pipeline to build ([task 3.3](/d3/3-3-databases/)). **Streaming ingestion** reads Kinesis Data Streams and MSK straight into materialized views, with low latency.
- **Redshift Spectrum** queries files in S3 through external tables in the Glue Data Catalog, without loading them, and can join them with tables in the warehouse: recent data in Redshift, older history in S3.
- **Table design**: **distribution styles** (AUTO, EVEN, KEY, ALL) decide which node holds each row, so tables joined on the same key can be joined without moving data; **sort keys** let queries skip blocks outside the range they filter on. Automatic table optimisation can choose both.
- **Speed for many users**: **materialized views** store the results of expensive queries, **concurrency scaling** adds capacity for bursts of concurrent queries, and the result cache answers repeated queries. **Data sharing** gives other Redshift warehouses, in other accounts and Regions too, access to live data without copying it.
- **Athena or Redshift?** Athena for occasional or ad hoc queries on data in S3, with nothing to run. Redshift for structured data queried all day by many users and dashboards that need consistent, fast results.

### EMR and OpenSearch

How EMR clusters are built (primary, core and task nodes, Spot) is in [task 3.2](/d3/3-2-compute/).

- **EMR deployment options**: EMR on EC2 for full control of the cluster, EMR on EKS to run Spark on an existing Kubernetes cluster, and **EMR Serverless** to run Spark and Hive jobs without sizing a cluster.
- **Keep the data in S3**, not in the cluster's HDFS. A **transient** cluster can then start, process a batch, write the results to S3 and terminate. Managed scaling resizes the cluster to the workload, and the Glue Data Catalog can be its metastore.
- **EMR or Glue?** Glue for serverless ETL with little to manage. EMR for open-source frameworks Glue doesn't offer (HBase, Presto, Flink), control of versions and tuning, long-running clusters, or very large jobs where you size the hardware yourself.
- **OpenSearch Service** indexes documents for full-text search and log analytics. Data arrives through Firehose, **OpenSearch Ingestion** (serverless pipelines that filter and transform data on the way in), the **DynamoDB zero-ETL integration** (which runs on OpenSearch Ingestion, with no code), or Lambda reading CloudWatch Logs subscription filters. **OpenSearch Serverless** removes cluster sizing, and **UltraWarm** and cold storage keep older logs searchable at a lower cost.

## Visualising data with Quick Sight (QuickSight)

**AWS Quick Sight** is serverless business intelligence: interactive dashboards on Athena, Redshift, RDS and Aurora, S3 files, OpenSearch, SaaS applications and databases reached over JDBC. It started as **Amazon QuickSight** and is now the BI feature of **AWS Quick** (renamed from Amazon Quick in November 2026). The exam guide says "Amazon Quick", and older questions say QuickSight: all three mean this service.

- **SPICE** is Quick Sight's in-memory engine. Importing a dataset into SPICE makes dashboards fast for many viewers and takes the load off the source; refreshes run on a schedule. A **direct query** reads the source every time, for data that must be current.
- **Users and groups** are managed in Quick, or come from IAM Identity Center or another SAML identity provider; IAM policies don't grant access to dashboards. **Row-level security** shows each user only their rows and **column-level security** hides columns; both need the **Enterprise edition**.
- **Embedding** puts dashboards into your own application, including for users who have no Quick account (row-level security for them works with tags).
- Other visual tools: **OpenSearch Dashboards** for logs and search data, **Amazon Managed Grafana** for operational metrics, CloudWatch dashboards for AWS metrics.

## AI services that turn unstructured data into data

Images, scanned documents, audio and free text become rows to store and query after an AI service has extracted what is in them. A common pipeline: a file lands in S3, an event starts a Lambda function, the service analyses the file, and the results go to DynamoDB, OpenSearch or the data lake.

| Input                       | Service                                                  | Output                                                                  |
| --------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Images and stored video     | Amazon Rekognition                                       | Labels, faces, text, unsafe content                                     |
| Scanned documents and forms | Amazon Textract                                          | Printed and handwritten text, tables, form fields                       |
| Speech                      | Amazon Transcribe                                        | Text, with PII redaction and language identification                    |
| Text                        | Amazon Comprehend (Comprehend Medical for clinical text) | Language, entities, key phrases, sentiment, PII (PHI and medical terms) |
| Text in another language    | Amazon Translate                                         | Translated text                                                         |
| Text to read aloud          | Amazon Polly                                             | Speech, tuned with SSML and lexicons                                    |
| Voice or chat conversations | Amazon Lex (with Amazon Connect for call centres)        | Chatbots that understand intents                                        |
| Documents to search         | Amazon Kendra                                            | Answers to natural-language questions                                   |
| Your own training data      | Amazon SageMaker AI                                      | Custom models that you build, train and deploy                          |

Some of these are closed to new customers: **Amazon Kendra** since 30 July 2026 (AWS points to Amazon Bedrock Knowledge Bases), and also Comprehend topic modelling and Rekognition streaming video analysis. Exam questions written before then may still name them.

## Loading data from databases and SaaS: DMS, zero-ETL and AppFlow

- **AWS DMS** reads from a database and writes to S3 (CSV or Parquet, optionally in date-based folders), Redshift, Kinesis Data Streams, MSK or other Kafka clusters, OpenSearch and DynamoDB. A **full load** copies the existing data; **CDC** then streams every change, so the lake or warehouse stays minutes behind the source. DMS runs on a replication instance (Multi-AZ for a standby) or as **DMS Serverless**, and the source stays online. Engine migrations and schema conversion are in [task 3.3](/d3/3-3-databases/).
- **Zero-ETL integrations** replicate data with no pipeline to build or run, from Aurora, RDS (MySQL, PostgreSQL, Oracle), DynamoDB, self-managed databases and SaaS applications such as Salesforce, SAP and ServiceNow. Most go into Redshift; some can also write to S3 or S3 Tables, and DynamoDB can also go to OpenSearch. When the source and target are supported, they replace a DMS or Glue pipeline.
- **Amazon AppFlow** moves data between SaaS applications (Salesforce, SAP, ServiceNow, Zendesk, Slack and others) and AWS services such as S3 and Redshift, on a schedule, on an event in the application, or on demand. It can filter, mask and validate fields on the way, and for some sources it travels over PrivateLink instead of the internet. Unlike zero-ETL, it can also send data back to the applications.
- **Files** from on-premises storage, partners or other clouds come in through DataSync, Transfer Family or Storage Gateway, and very large one-time copies through an offline transfer; all of them are in [task 3.1](/d3/3-1-storage/). A database too big for the link that keeps changing: load a backup or export through an offline transfer, then start DMS CDC from the time of that backup.

## If the exam says… → think…

| If the exam says…                                                        | Think…                                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Query data in S3 with SQL, serverless, nothing to manage                 | Amazon Athena                                                                                   |
| Ad hoc SQL on CloudTrail, VPC Flow Logs or ALB logs stored in S3         | Athena                                                                                          |
| Athena queries are slow and expensive on CSV logs                        | Convert to Parquet or ORC, partition by date, compress, combine small files                     |
| Queries always filter by date but scan the whole table                   | Partition by date (Hive-style prefixes), or partition projection                                |
| Thousands of new partitions every day, and crawlers can't keep up        | Athena partition projection                                                                     |
| Convert CSV files that arrive in S3 to Parquet                           | A Glue ETL job started by an S3 event through EventBridge (or Athena CTAS for a one-off)        |
| Stream JSON records into S3 as Parquet with no code                      | Data Firehose record format conversion with a Glue table schema                                 |
| Write streamed records to S3 folders per customer                        | Firehose dynamic partitioning                                                                   |
| Infer the schema of files in S3 and make them queryable                  | Glue crawler into the Glue Data Catalog                                                         |
| Process only the files added since the last ETL run                      | Glue job bookmarks                                                                              |
| Analysts must clean and normalise data without writing code              | Glue DataBrew                                                                                   |
| A data lake with central, column- and row-level permissions              | Lake Formation                                                                                  |
| Grant access to many tables by data sensitivity, including future tables | Lake Formation LF-Tags                                                                          |
| Share data lake tables with another account without copying them         | Lake Formation cross-account grants (through AWS RAM)                                           |
| Updates and deletes of individual rows in data lake tables               | Apache Iceberg tables (or S3 Tables)                                                            |
| Real-time aggregations over time windows on a stream                     | Managed Service for Apache Flink reading Kinesis Data Streams or MSK                            |
| Move existing Kafka applications to AWS without code changes             | Amazon MSK                                                                                      |
| Kafka without managing broker capacity                                   | MSK Serverless                                                                                  |
| Stream records larger than 1 MB                                          | MSK with a larger message size, or Kinesis Data Streams with the 10 MiB limit set on the stream |
| Kinesis producers get throughput exceptions                              | More shards (or on-demand mode), a partition key that spreads the load, batched writes          |
| Devices must upload to Kinesis without long-term AWS credentials         | Amazon Cognito identity pool for temporary credentials                                          |
| Ingestion from a VPC must not cross the internet                         | Interface VPC endpoints for Kinesis or Firehose, a gateway endpoint for S3                      |
| Data warehouse for complex SQL and BI dashboards used all day            | Amazon Redshift                                                                                 |
| Query S3 data from Redshift without loading it                           | Redshift Spectrum                                                                               |
| Load large amounts of data into Redshift fast                            | `COPY` from S3, split into several files                                                        |
| Analytics on Aurora data without ETL pipelines or load on the database   | Zero-ETL integration with Redshift                                                              |
| Spikes of concurrent Redshift queries at month end                       | Concurrency scaling                                                                             |
| Share live Redshift data with another account or Region without copying  | Redshift data sharing                                                                           |
| Large Spark or Hadoop jobs, with control of the framework                | Amazon EMR (transient clusters, data in S3)                                                     |
| Spark jobs without sizing or managing a cluster                          | EMR Serverless, or Glue                                                                         |
| Full-text search or log analytics with near real-time dashboards         | OpenSearch Service, fed by Firehose or OpenSearch Ingestion                                     |
| Interactive BI dashboards for business users, embedded in an app         | Quick Sight (QuickSight) dashboards, embedded, with SPICE for speed                             |
| Each sales manager must see only their own region's rows in a dashboard  | Quick Sight row-level security (or Lake Formation data filters at the source)                   |
| Continuously copy changes from an on-premises database into S3           | AWS DMS full load plus CDC, S3 target in Parquet                                                |
| Load Salesforce data into S3 or Redshift on a schedule                   | Amazon AppFlow                                                                                  |
| Extract fields from scanned forms and invoices                           | Amazon Textract                                                                                 |
| Sentiment of customer emails or reviews                                  | Amazon Comprehend                                                                               |
| Text from recorded calls, without personal data                          | Amazon Transcribe with PII redaction                                                            |

## Common traps

- **Firehose can't be read.** Flink, Lambda and your own consumers read from Kinesis Data Streams or MSK; Firehose only delivers.
- **Firehose format conversion takes JSON.** CSV needs a Lambda transformation first, and the conversion needs a schema in the Glue Data Catalog.
- **Partitioning only helps queries that filter on the partition columns**, and partitioning by a high-cardinality column makes things worse.
- **Many small files hurt Athena** even in Parquet. Compact them into larger files.
- **A GZIP-compressed CSV can't be split**, so one reader handles the whole file.
- **Athena isn't a data warehouse.** Heavy, repeated dashboard queries from many users point to Redshift.
- **Redshift is for analytics (OLAP), not transactions.** An application's orders database stays in RDS, Aurora or DynamoDB.
- **Single-row `INSERT`s into Redshift are slow.** Load in bulk with `COPY` from S3.
- **A crawler doesn't move or transform data.** It only writes metadata into the Data Catalog.
- **Lake Formation permissions work through integrated engines.** Users who also have direct S3 access to the files bypass them.
- **Quick Sight (QuickSight) dashboards and datasets aren't shared with IAM policies.** They are shared with Quick users and groups, which can come from an identity provider.
- **DMS needs at least one endpoint in AWS**, and it moves data, not schemas: converting a schema to a new engine is DMS Schema Conversion ([task 3.3](/d3/3-3-databases/)).
- **Bandwidth is in bits.** Multiply bytes by 8 before you divide by the link speed.

## Links

**AWS documentation**

- [Kinesis Data Streams quotas](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html), [What is Amazon MSK?](https://docs.aws.amazon.com/msk/latest/developerguide/what-is-msk.html) and [Managed Service for Apache Flink](https://docs.aws.amazon.com/managed-flink/latest/java/what-is.html)
- [Firehose record format conversion](https://docs.aws.amazon.com/firehose/latest/dev/record-format-conversion.html) and [dynamic partitioning](https://docs.aws.amazon.com/firehose/latest/dev/dynamic-partitioning.html)
- [The AWS Glue Data Catalog](https://docs.aws.amazon.com/glue/latest/dg/catalog-and-crawler.html), [building visual ETL jobs in Glue](https://docs.aws.amazon.com/glue/latest/dg/author-job-glue.html) and [What is AWS Lake Formation?](https://docs.aws.amazon.com/lake-formation/latest/dg/what-is-lake-formation.html)
- [Athena performance tuning](https://docs.aws.amazon.com/athena/latest/ug/performance-tuning.html) and [partition projection](https://docs.aws.amazon.com/athena/latest/ug/partition-projection.html)
- [Amazon Redshift best practices](https://docs.aws.amazon.com/redshift/latest/dg/best-practices.html), [What is Amazon EMR?](https://docs.aws.amazon.com/emr/latest/ManagementGuide/emr-what-is-emr.html) and [What is Amazon OpenSearch Service?](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/what-is.html)
- [What is AWS Quick?](https://docs.aws.amazon.com/quick/latest/userguide/what-is.html), [AWS DMS targets](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Target.html) and [What is Amazon AppFlow?](https://docs.aws.amazon.com/appflow/latest/userguide/what-is-appflow.html)

**Practice**

- [Practice tests](/practice/): in the **Practice** card, choose **Practice by: Task** and then **3.5** to drill only this task.
