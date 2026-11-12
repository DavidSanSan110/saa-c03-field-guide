---
title: 'Task 3.2: Design high-performing and elastic compute solutions'
description: 'Choosing between EC2, containers, Lambda, Elastic Beanstalk, AWS Batch and EMR, EC2 instance families and sizing, placement groups and enhanced networking (ENA, EFA), scaling on the right metric, ECS, Fargate, EKS and ECR, Lambda memory and concurrency, edge functions, and HPC building blocks, with exam cues and common traps.'
---

Compute questions in this task describe a workload (a web tier with a morning peak, a two-hour nightly job, a simulation whose nodes talk to each other all the time) and ask what to run it on, how big, and how it should grow. Work through three choices in order: the **service** (instances, containers or functions), the **shape** (instance family, task size, function memory), and the **scaling** (which metric, how fast new capacity is ready). Choosing the cheapest way to pay for it is task 4.2.

Part of [Domain 3: Design High-Performing Architectures](/d3/).

## Choosing a compute service

| Service                  | You manage                                          | Scales by                                                       | Pick it for                                                                                         |
| ------------------------ | --------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Amazon EC2               | The OS, patches, the AMI, scaling settings          | Auto Scaling groups adding and removing instances               | Full control: special instance types, licences tied to hosts, software that needs a whole server    |
| Amazon ECS or EKS on EC2 | The container images and the cluster's instances    | Service auto scaling for tasks, capacity providers for hosts    | Containers that need GPUs, specific instance types or a high, steady load packed onto few hosts     |
| AWS Fargate              | The container images and the task size              | More tasks; no servers to plan                                  | Containers with no servers to manage: web services, APIs, jobs longer than Lambda allows            |
| AWS Lambda               | The code and the memory setting                     | One execution environment per concurrent request, automatically | Event-driven code and spiky, short requests, up to 15 minutes each                                  |
| AWS Elastic Beanstalk    | The application code and the environment's settings | The Auto Scaling group it creates for you                       | A standard web app or worker deployed quickly, without building the load balancer and group by hand |
| AWS Batch                | Job definitions and the compute environment limits  | Launching the instances or Fargate tasks the job queue needs    | Batch and HPC jobs of any length, in queues, with retries and dependencies                          |
| Amazon EMR               | The cluster (or nothing, with EMR Serverless)       | Adding core and task nodes, or by itself on EMR Serverless      | Big data frameworks: Apache Spark, Hive, Presto, Hadoop                                             |

- **Decouple first.** A queue or a stream between tiers lets each one scale on its own metric: the web tier on requests, the workers on the backlog. That pattern is in [task 2.1](/d2/2-1-scalable-loosely-coupled/).
- **Elastic Beanstalk** creates and runs the usual pieces (EC2 instances, an Auto Scaling group, a load balancer, optionally a database) from your code, for Java, .NET, Node.js, Python, PHP, Ruby, Go or Docker. Beanstalk itself is free; you pay for what it creates. (That is the Standard mode; a newer Cluster mode runs the app on EKS.) A **web server** environment answers HTTP; a **worker** environment runs a daemon that reads an SQS queue and posts each message to your app.
- **Amazon EMR** clusters have a **primary** node, **core** nodes that run tasks and store HDFS data, and optional **task** nodes that only run tasks. Task nodes hold no data, so they are the safe place for Spot Instances.
- **Compute close to users.** **Local Zones** put EC2 and other services in a metro area away from the Region, for single-digit millisecond latency to local users. **Wavelength Zones** sit inside telecom 5G networks for mobile apps. **AWS Outposts** are racks or servers of AWS hardware in your own data centre, for data that must stay on site or needs very low latency to local systems.

## EC2 instance families and sizing

| Family                | Series (examples)                          | Built for                                                                                   |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| General purpose       | M, T (burstable), Mac                      | A balance of CPU, memory and network: web servers, small databases, code repositories       |
| Compute optimised     | C                                          | A high ratio of CPU to memory: batch processing, video encoding, game servers, ad serving   |
| Memory optimised      | R, X, U (high memory), z                   | Large data sets in memory: in-memory databases and caches, real-time big data analytics     |
| Storage optimised     | I, D, H                                    | Fast local NVMe or HDD instance store: NoSQL databases, data warehousing, distributed files |
| Accelerated computing | P, G (GPU), Trn, Inf (AWS chips), F (FPGA) | Machine learning training and inference, graphics, video transcoding                        |
| HPC optimised         | Hpc6a, Hpc6id, Hpc7a, Hpc7g, Hpc8a         | Tightly coupled simulations with the best price performance for HPC, with EFA built in      |

- **Reading a name**: in `c7gn.2xlarge`, `c` is the series, `7` the generation, `g` the processor (`g` AWS Graviton, `a` AMD, `i` Intel), `n` an extra capability (here network and EBS bandwidth; `d` means local NVMe instance store, `e` extra memory or storage) and `2xlarge` the size. vCPUs and memory grow in proportion to the size: a `2xlarge` has twice the vCPUs and memory of an `xlarge`.
- **Newer generations** give more performance for the same or a lower price, so "move to the current generation" is often part of a right answer.
- **AWS Graviton** (Arm) instances give the best price performance in EC2 for most workloads, as long as the software and its dependencies have Arm builds (container images must be built for arm64 too).
- **Burstable T instances** (T3, T3a, T4g) earn CPU credits while below a baseline and spend them to burst above it. In **standard** mode an instance with no credits drops to its baseline; in **unlimited** mode (the default for T3, T3a and T4g) it keeps bursting and pays for the surplus. A workload that runs above the baseline most of the time is cheaper and faster on an M or C instance.
- **Right-sizing**: AWS Compute Optimizer reads CloudWatch metrics and recommends instance types, Auto Scaling group settings, EBS volumes, Lambda memory and Fargate task sizes. Memory use isn't an EC2 metric by default: it needs the CloudWatch agent on the instance.
- **Faster starts**: **hibernation** saves the instance's memory to its encrypted EBS root volume when it stops and loads it back on start, so the application comes back already warm. It needs the option set at launch, a supported instance type with less than 150 GiB of memory on Linux (16 GiB on Windows), and room on the root volume for the RAM.

## Placement groups and enhanced networking

| Strategy  | How instances are placed                                                              | Limits                                                             | Pick it for                                                                                 |
| --------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Cluster   | Packed close together in one AZ, on a low-latency, high-bandwidth part of the network | One AZ; a capacity error is more likely when the group grows       | Tightly coupled HPC, jobs whose nodes exchange a lot of data: lowest latency, highest speed |
| Partition | Split into partitions; instances in different partitions never share a rack           | Up to 7 partitions per AZ; no instance limit beyond account quotas | Large distributed and replicated systems such as HDFS, HBase, Cassandra and Kafka           |
| Spread    | Every instance on its own rack, with its own network and power                        | Up to 7 running instances per AZ per group; can span several AZs   | A few critical instances that must not fail together                                        |

- **Cluster placement groups** raise the per-flow limit for normal traffic: up to 10 Gbps for one flow inside the group, against 5 Gbps outside it (ENA Express goes further, see below). To get the capacity, launch all the instances in one request with the same instance type; if a later launch fails for lack of capacity, stopping and starting every instance in the group can move them to hardware that has room. An On-Demand Capacity Reservation in the group holds the capacity in advance. Burstable T instances can't join a cluster placement group.
- **Partition placement groups** tell the instance which partition it is in (through instance metadata), so a topology-aware system such as HDFS or Cassandra can keep its replicas in different partitions and survive the loss of a rack.
- A placement group is free. An existing instance can be moved into one or out of it while it is stopped.

**Enhanced networking** uses SR-IOV to give an instance higher bandwidth, more packets per second and lower, more consistent latency, at no extra cost.

| Network interface             | What it gives                                                                                                                                                            | Use it for                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| ENA (Elastic Network Adapter) | Enhanced networking on every Nitro-based instance; bandwidth depends on the type and size, up to 100 Gbps per interface (more on large types with several network cards) | Every workload: it is on by default with current AMIs                           |
| ENA Express                   | The SRD protocol over ENA: up to 25 Gbps per flow within a Region, and lower tail latency                                                                                | Single TCP or UDP flows that need more than 5 to 10 Gbps, without changing code |
| EFA (Elastic Fabric Adapter)  | An ENA plus **OS bypass**: MPI and NCCL applications talk to the adapter through Libfabric, skipping the operating system kernel                                         | Tightly coupled HPC (MPI) and distributed ML training across many GPU instances |
| Intel 82599 VF                | Up to 10 Gbps on some older instance types                                                                                                                               | Legacy only                                                                     |

- **ENA Express** works between instances in the same AZ or in different AZs of one Region, within each instance's own bandwidth, and both instances must have it turned on.
- **EFA traffic isn't routable.** It can cross subnets within one AZ, but not AZs or VPCs, so put the nodes in one AZ, ideally in a cluster placement group, and give them a security group that allows all traffic to and from itself. OS bypass is a Linux feature; on Windows an EFA works as an ENA (except for AWS CDI SDK applications).
- An instance's "up to" bandwidth is a burst figure; the steady baseline of small sizes is lower. Traffic through an internet gateway is limited to 5 Gbps on instances with fewer than 32 vCPUs, and to half the instance's bandwidth on larger ones.

## Scaling compute elastically

Elastic compute adds capacity before users notice the load and removes it when the load is gone. Auto Scaling policies (target tracking, step, scheduled, predictive) are compared in [task 2.1](/d2/2-1-scalable-loosely-coupled/); this task asks which **metric** to scale on and how to make new capacity **ready faster**.

| Workload                                      | Scale on                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| CPU-bound web or API tier                     | Average CPU utilisation of the group                                             |
| Web tier behind an ALB                        | `ALBRequestCountPerTarget`: requests per instance or task                        |
| Workers reading an SQS queue                  | Backlog per instance: visible messages divided by the number of workers          |
| Memory-bound application                      | Memory utilisation, published by the CloudWatch agent (not a default EC2 metric) |
| Daily or weekly peaks you can see in the past | Predictive scaling, or a scheduled action before a known event                   |

- **Warm pools** keep pre-initialised instances next to an Auto Scaling group, stopped (pay only for their EBS volumes and Elastic IP addresses), hibernated or running. A scale-out takes one from the pool instead of booting and configuring a new one, which helps applications that take minutes to start. A group that launches Spot Instances can't have a warm pool.
- **Launch faster**: bake the software into the AMI instead of installing it in user data, and set the **instance warm-up** to the real start time so new instances' metrics don't trigger more scaling while they start.
- **React sooner**: EC2 sends metrics every 5 minutes by default; **detailed monitoring** sends them every minute, so scaling policies see a spike earlier.
- **Mixed instances policy**: one group can launch several instance types (or pick them from attributes such as vCPUs and memory) and mix On-Demand and Spot. More types mean the group still scales when one type is short of capacity.
- **Containers scale in two layers.** ECS service auto scaling changes the number of tasks; on EC2, a **capacity provider** with managed scaling adds or removes instances so that the tasks have somewhere to run. On Fargate only the first layer exists.
- **Beyond EC2 groups**: **Application Auto Scaling** applies target tracking and scheduled scaling (and step scaling for most resources) to ECS services, DynamoDB capacity, Aurora replicas, Spot Fleets and Lambda provisioned concurrency. A **scaling plan** in **AWS Auto Scaling** sets up scaling for several resources of one application at once.

## Containers: ECS, Fargate, EKS and ECR

**Amazon ECS** runs containers from a **task definition** (images, CPU and memory, ports, IAM task role, logging). A **service** keeps a number of tasks running, replaces failed ones and registers them with a load balancer; a standalone task runs once, for example from an EventBridge rule or schedule.

| Where ECS tasks run     | Who manages the servers                                                 | Notes                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Fargate                 | AWS; there are no instances to see                                      | Each task gets its own isolated environment, up to 32 vCPU and 244 GB of memory (Linux); Fargate Spot for jobs that can be interrupted |
| ECS Managed Instances   | AWS runs EC2 instances in your account: provisioning, patching, scaling | EC2 choice (GPUs, specific families) without managing the hosts                                                                        |
| EC2 (self-managed)      | You: an Auto Scaling group of instances running the ECS agent           | Full control of the hosts, AMI and instance types; you patch and scale them                                                            |
| External (ECS Anywhere) | You: your own servers on premises                                       | Same ECS control plane for servers outside AWS                                                                                         |

- **Load balancing**: an ALB for HTTP, with dynamic host ports so many tasks can share one instance; an NLB for very high throughput, TCP or UDP, or a PrivateLink service. Tasks in `awsvpc` network mode (every Fargate task) get their own network interface and register by IP, so the target group's type must be `ip`.
- **Storage**: EFS volumes give tasks in every AZ the same files, on Fargate and EC2. A Fargate task also gets 20 GiB of ephemeral storage, which can be raised to 200 GiB.
- **Two IAM roles.** The **task role** is what the application's code uses to call AWS. The **task execution role** is what ECS uses to pull the image from ECR, send logs and read secrets for the task.

**Amazon EKS** runs the Kubernetes control plane for you, across several AZs. Pods run on **managed node groups** (EKS creates the EC2 nodes and their group, and updates them in one operation when you ask, draining pods first), **self-managed nodes**, **Fargate** (each pod in its own environment, in private subnets; no DaemonSets and no Fargate Spot on EKS), or **EKS Auto Mode**, which also chooses, launches and patches the nodes. Pods scale with the Horizontal Pod Autoscaler and nodes with Karpenter or the Cluster Autoscaler. Pick EKS when the team already uses Kubernetes or needs to run the same tooling in several places; pick ECS for the simplest fully AWS-managed option.

**Amazon ECR** stores private and public container images, with IAM and repository policies, image scanning (basic, or enhanced with Amazon Inspector), lifecycle policies that delete old images, and cross-Region and cross-account replication. Pulling from a repository in the same Region is fastest and avoids data transfer costs. **Pull through cache** keeps copies of images from an upstream registry, such as ECR Public, Docker Hub, GitHub Container Registry or another ECR registry, in your private registry. Large images slow down every task start; on Fargate, a **SOCI index** lets a task start before the whole image is downloaded.

## Lambda sizing and edge functions

Lambda has one size setting: **memory**, from 128 MB to 10,240 MB. CPU and network grow with it: at 1,769 MB a function has the equivalent of one vCPU, and at 10,240 MB up to six. A CPU-bound function often costs the same or less at a higher memory setting, because it finishes sooner and you pay per GB-second. Limits, concurrency controls and the VPC are in [task 2.1](/d2/2-1-scalable-loosely-coupled/).

- **Architecture**: functions on **arm64** (Graviton) have better price performance than x86_64 for most code.
- **Scaling rate**: each function can add 1,000 concurrent execution environments every 10 seconds, until it reaches the account's concurrency quota (1,000 per Region by default). A sudden spike bigger than that is throttled while Lambda scales.
- **Cold starts** happen when Lambda creates a new execution environment and runs the initialisation code. Keep packages small, initialise SDK clients and database connections outside the handler so later invocations reuse them, and use **provisioned concurrency** (always warm, charged) when the first request must be fast. **SnapStart** (Java, Python and .NET) restores from a snapshot of an initialised environment, so cold starts are much shorter, but they still happen.
- **Long or heavy work** doesn't fit: an invocation runs for at most 15 minutes and gets no GPU, so longer or GPU jobs belong on Fargate, ECS, Batch or EC2. (The newer Lambda Managed Instances allow 90 minutes for asynchronous and event source invocations; exam questions use 15.)

**Edge functions** run code at CloudFront locations close to viewers, for small changes to requests and responses.

|                 | CloudFront Functions                                                                     | Lambda@Edge                                                                           |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Runtime         | JavaScript                                                                               | Node.js and Python                                                                    |
| Triggers        | Viewer request and viewer response                                                       | Viewer request and response, origin request and response                              |
| Execution time  | Under 1 millisecond                                                                      | Up to 30 seconds                                                                      |
| Memory          | 2 MB                                                                                     | 128 MB on viewer events, up to 10,240 MB on origin events                             |
| Network, body   | No network or file system access, no request body                                        | Network access, can read and change the request body                                  |
| Scale and price | Millions of requests per second; about one sixth the price                               | Up to 10,000 requests per second per Region; charged per request and per GB-second    |
| Use it for      | Header changes, URL rewrites and redirects, cache key normalisation, simple token checks | Calls to other services, image changes, logic that needs libraries or longer run time |

Lambda@Edge functions are created in US East (N. Virginia) and CloudFront copies them to its locations. They can't use a VPC, provisioned concurrency, arm64 or container images.

## High performance computing

HPC jobs come in two shapes. **Tightly coupled** jobs (weather models, fluid dynamics, crash simulations) split one problem across many nodes that exchange messages all the time, so they are limited by network latency between nodes. **Loosely coupled** jobs (rendering frames, genomics pipelines, Monte Carlo risk runs) are many independent pieces, limited only by how many cores you can get.

| Need                         | Building blocks                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compute                      | HPC optimised (Hpc7a, Hpc7g), compute optimised or GPU instances; Spot Instances (not for HPC optimised types) for loosely coupled work that can be retried |
| Network between nodes        | A cluster placement group in one AZ, EFA, and one instance type for all the nodes                                                                           |
| Shared storage               | FSx for Lustre, linked to S3 for input and results (see [task 3.1](/d3/3-1-storage/)); instance store for scratch data                                      |
| Scheduling and orchestration | AWS Batch, AWS ParallelCluster, AWS Parallel Computing Service                                                                                              |
| Getting the data in          | AWS DataSync or Direct Connect for on-premises data sets                                                                                                    |

- **AWS Batch** runs jobs from **job queues** on **compute environments** (EC2 On-Demand or Spot, Fargate or Fargate Spot, or ECS Managed Instances, orchestrated through ECS or EKS) that it scales up and down as jobs arrive; there is no charge for Batch itself. **Array jobs** run the same job over many inputs, the loosely coupled shape. **Multi-node parallel jobs** run one job across several EC2 instances, the tightly coupled shape; they can't run on Spot and work best in a cluster placement group.
- **AWS ParallelCluster** is an open-source tool that builds a Slurm cluster (VPC settings, head node, compute queues, shared FSx for Lustre, EFA) from a YAML configuration file; since version 3.16 it no longer offers AWS Batch as a scheduler. **AWS Parallel Computing Service** is the managed option, which AWS now recommends for new clusters: AWS runs the Slurm controller for you.
- Loosely coupled jobs can spread across AZs and instance types for more capacity; only tightly coupled jobs need everything in one AZ.

## If the exam says… → think…

| If the exam says…                                                         | Think…                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Lowest latency and highest throughput between instances for an MPI job    | Cluster placement group + EFA, one AZ, one instance type                        |
| Kafka, HDFS or Cassandra nodes must not lose replicas to one rack failure | Partition placement group                                                       |
| A handful of critical instances must never fail together                  | Spread placement group                                                          |
| One TCP flow between two instances needs more than 10 Gbps                | ENA Express (up to 25 Gbps per flow), or split it into several flows            |
| Distributed ML training across many GPU instances is network-bound        | EFA with NCCL                                                                   |
| In-memory database or cache with hundreds of GB of RAM                    | Memory optimised (R, X, high memory U)                                          |
| Video encoding, batch processing or game servers limited by CPU           | Compute optimised (C)                                                           |
| A T instance is slow and runs out of CPU credits                          | Move to M or C (or unlimited mode for short bursts)                             |
| Better price performance for an app that has Arm builds                   | Graviton instances (or arm64 Lambda)                                            |
| Instances take minutes to start and the scale-out is too slow             | Warm pool, a pre-baked AMI, the right instance warm-up                          |
| Daily peak at the same time, instances must be ready before it            | Predictive scaling or a scheduled action                                        |
| Workers fall behind an SQS queue                                          | Scale on backlog per instance                                                   |
| Scale on memory use of EC2 instances                                      | CloudWatch agent custom metric                                                  |
| Containers with no servers to manage                                      | Fargate (ECS or EKS)                                                            |
| Containers that need GPUs, without managing hosts                         | ECS on EC2 GPU instances (newer: ECS Managed Instances or EKS Auto Mode)        |
| Company already runs Kubernetes and wants the same tooling on AWS         | Amazon EKS                                                                      |
| Each container needs its own permissions to S3 or DynamoDB                | ECS task role                                                                   |
| Job runs longer than 15 minutes                                           | Fargate, ECS, AWS Batch or EC2, not Lambda                                      |
| CPU-heavy Lambda function is slow                                         | Raise its memory (CPU grows with it)                                            |
| First request to a Lambda function must not see a cold start              | Provisioned concurrency (SnapStart shortens cold starts for Java, Python, .NET) |
| Rewrite URLs or headers for every viewer request at very high volume      | CloudFront Functions                                                            |
| Edge logic needs network calls, the request body or more than 1 ms        | Lambda@Edge                                                                     |
| Thousands of independent batch jobs, at low cost, with retries            | AWS Batch array jobs on Spot                                                    |
| Deploy a web app quickly without designing the ALB and Auto Scaling group | Elastic Beanstalk                                                               |
| Spark or Hadoop jobs on a managed cluster                                 | Amazon EMR (Spot on task nodes)                                                 |
| Single-digit millisecond latency for users in a city far from the Region  | Local Zones                                                                     |

## Common traps

- **A cluster placement group is one AZ.** It is for speed; an AZ failure takes the whole group down.
- **Spread placement groups hold at most 7 running instances per AZ.** Big fleets need partition groups.
- **EFA doesn't route.** Its traffic can't cross AZs or VPCs; only the ENA side of the interface is routable.
- **Cluster placement groups can't hold burstable T instances.**
- **Enhanced networking is free** and already on with current-generation instances and AMIs; there is nothing to buy.
- **"Up to" bandwidth is a burst.** Small instance sizes have a lower steady baseline.
- **EC2 has no memory metric by default.** Scaling or right-sizing on memory needs the CloudWatch agent.
- **Unlimited mode isn't free.** A T instance that bursts all the time pays for surplus credits; it may cost more than an M instance.
- **Lambda has no CPU setting.** Raise the memory to get more CPU.
- **Reserved concurrency doesn't warm anything.** It caps and guarantees concurrency; only provisioned concurrency removes cold starts, and SnapStart makes them shorter.
- **Fargate has no GPUs.** GPU containers need EC2 capacity: ECS on EC2 or Managed Instances, or EKS nodes.
- **ECS service auto scaling adds tasks, not instances.** On EC2, the capacity provider must add hosts as well.
- **CloudFront Functions can't make network calls.** Anything that calls an API or reads the body is Lambda@Edge.
- **Hibernation keeps RAM, not the instance's place on the host.** The instance store is still lost, and the root volume must be EBS and encrypted.

## Links

**AWS documentation**

- [Amazon EC2 instance types](https://docs.aws.amazon.com/ec2/latest/instancetypes/instance-types.html) and [burstable performance instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances.html)
- [Placement groups](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/placement-groups.html)
- [Enhanced networking](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/enhanced-networking.html), [ENA Express](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ena-express.html) and [Elastic Fabric Adapter](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/efa.html)
- [Warm pools for Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-warm-pools.html)
- [Amazon ECS launch types and capacity providers](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/capacity-launch-type-comparison.html) and [service auto scaling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html)
- [Amazon EKS compute options](https://docs.aws.amazon.com/eks/latest/userguide/eks-compute.html) and [What is Amazon ECR?](https://docs.aws.amazon.com/AmazonECR/latest/userguide/what-is-ecr.html)
- [Configuring Lambda function memory](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html) and [Lambda scaling behaviour](https://docs.aws.amazon.com/lambda/latest/dg/scaling-behavior.html)
- [Differences between CloudFront Functions and Lambda@Edge](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-choosing.html)
- [What is AWS Batch?](https://docs.aws.amazon.com/batch/latest/userguide/what-is-batch.html) and [AWS ParallelCluster](https://docs.aws.amazon.com/parallelcluster/latest/ug/what-is-aws-parallelcluster.html)
- [What is AWS Elastic Beanstalk?](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/Welcome.html)

**Practice**

- [Practice tests](/practice/): in the **Practice** card, choose **Practice by: Task** and then **3.2** to drill only this task.
