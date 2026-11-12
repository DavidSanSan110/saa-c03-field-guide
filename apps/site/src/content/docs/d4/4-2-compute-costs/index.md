---
title: 'Task 4.2: Design cost-optimized compute solutions'
description: 'What EC2, Lambda, Fargate, ECS and EKS charge for, EC2 purchasing options (On-Demand, Savings Plans, Reserved Instances, Spot, Dedicated Hosts and Instances, Capacity Reservations), Spot-friendly designs, mixing commitments, On-Demand and Spot in one Auto Scaling group, right-sizing and Graviton, schedules for non-production, EC2 vs containers vs Lambda on cost, load balancer choice, licensing, Regions, edge and hybrid compute, with exam cues and common traps.'
---

Cost questions about compute describe how a workload runs (around the clock, only in office hours, in short bursts a few times a day, as a batch that can start again if it is stopped) and ask for the cheapest way to run it without breaking what it needs. Work out three things first: **how steady** the load is, **whether it can be interrupted**, and **how long** you can commit. Steady and long → a commitment (Savings Plans or Reserved Instances). Interruptible → Spot. Short, spiky or mostly idle → pay only while it runs (Lambda, Fargate, On-Demand with scaling). Most real answers combine them.

Which service, instance family and scaling metric fit a workload is in [task 3.2](/d3/3-2-compute/). This page is about what they cost. The tools that track and analyse spend for every task (Budgets, Cost Explorer, Cost Anomaly Detection, Compute Optimizer, Trusted Advisor, cost allocation tags) are on the [Domain 4 overview](/d4/#cost-management-tools).

Part of [Domain 4: Design Cost-Optimized Architectures](/d4/).

## What each compute option charges for

| Option                       | You pay for                                                                                                                                                                   | Main cost levers                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Amazon EC2                   | Instance time while running (per second for Linux, Windows, RHEL and Ubuntu, 60 seconds minimum), plus EBS, public IPv4, data transfer                                        | Purchasing option, instance type and size, Graviton, stopping what isn't needed |
| AWS Lambda                   | Requests, plus duration in GB-seconds (memory × time, per millisecond, including the initialisation of cold starts since August 2025), plus provisioned concurrency if set    | Memory setting, arm64, shorter code, not keeping idle provisioned concurrency   |
| AWS Fargate                  | vCPU and memory per second for each running task (one minute minimum for Linux; five minutes plus an OS licence fee for Windows), plus ephemeral storage above the free 20 GB | Task size, Fargate Spot, arm64, scaling the task count to the load              |
| Amazon ECS                   | Nothing for ECS itself: the EC2 instances or Fargate tasks it runs on (ECS Managed Instances add a management fee)                                                            | Packing tasks densely onto instances, Spot capacity providers                   |
| Amazon EKS                   | A fee per cluster per hour (higher on extended support), plus the nodes, Fargate pods or Auto Mode instances (EC2 price plus an Auto Mode management fee)                     | Fewer clusters, staying on standard-support Kubernetes versions, Spot nodes     |
| AWS Batch, Elastic Beanstalk | Nothing for the service: the resources they create                                                                                                                            | The purchasing option of what they launch (Spot for Batch)                      |

- **A stopped instance** doesn't pay for instance time, but its EBS volumes and Elastic IP addresses keep billing (the public IPv4 address assigned automatically at launch is released when it stops). A hibernated instance is billed like a stopped one; its root volume also holds the saved memory.
- **Reserving capacity isn't the same as a discount.** An On-Demand Capacity Reservation bills at the On-Demand rate whether an instance uses it or not; a Savings Plan or Reserved Instance lowers the rate.

## EC2 purchasing options

| Option                          | Commitment                                                                                                                                         | Discount vs On-Demand                                                                  | Fits                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| On-Demand                       | None                                                                                                                                               | None                                                                                   | Short, unpredictable or new workloads that can't be interrupted                     |
| Compute Savings Plans           | $/hour of compute for 1 or 3 years                                                                                                                 | Up to 66 %                                                                             | Steady spend that may change family, size, Region, OS or move to Fargate and Lambda |
| EC2 Instance Savings Plans      | $/hour for one instance family in one Region, 1 or 3 years                                                                                         | Up to 72 %                                                                             | Steady use of one family in one Region, any size, OS, tenancy or AZ                 |
| Standard Reserved Instances     | An instance type and Region (or AZ), 1 or 3 years                                                                                                  | Up to 72 %                                                                             | Steady, well-known instance use; can be sold on the Reserved Instance Marketplace   |
| Convertible Reserved Instances  | Same, but can be exchanged for other attributes                                                                                                    | Up to 66 %                                                                             | Steady use whose instance type may change                                           |
| Spot Instances                  | None; AWS can take the instance back                                                                                                               | Up to 90 %                                                                             | Fault-tolerant, flexible, stateless or checkpointed work                            |
| On-Demand Capacity Reservations | None for reservations that start now (cancel any time); future-dated ones must be kept for a minimum commitment period; billed whether used or not | None by itself                                                                         | Capacity that must be there in one AZ: a launch event, DR, regulated workloads      |
| Dedicated Instances             | None (Savings Plans and Reserved Instances apply)                                                                                                  | Costs more than shared tenancy, plus $2 an hour in each Region where at least one runs | Hardware not shared with other AWS accounts, without host-level control             |
| Dedicated Hosts                 | Per host: On-Demand, Dedicated Host Reservations (up to 70 % off) or Savings Plans                                                                 | Costs the most                                                                         | Licences tied to sockets or physical cores (BYOL), host-level visibility            |

- **Payment options** for Savings Plans and Reserved Instances: **All Upfront** gives the biggest discount, **Partial Upfront** less, **No Upfront** the least. Three years gives more than one.
- **Usage above the commitment** is billed at On-Demand rates. A commitment is used up every hour, so a Savings Plan sized for a peak is wasted the rest of the day: commit to the steady baseline only.
- **Order of discounts.** Each hour, Reserved Instances apply first, then Savings Plans to the usage left over; the rest is On-Demand. Spot Instances aren't covered by either.
- **Reserved Instances can't be cancelled** and don't renew themselves: when the term ends, the instances keep running at On-Demand rates.
- **Capacity Blocks for ML** reserve GPU or Trainium instances placed close together, for 1 to 182 days, starting up to 8 weeks ahead, for training runs that need many accelerators at a known time. They are paid upfront, can't be cancelled, and Savings Plans and Reserved Instances don't apply to them.

### Savings Plans or Reserved Instances?

AWS recommends Savings Plans for new commitments: they give the same discounts with less management, because they apply to usage instead of to a named instance type.

|                       | Compute Savings Plans                                            | EC2 Instance Savings Plans                                | Reserved Instances (regional)                                                             |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Applies to            | EC2 in any family, size, OS, tenancy and Region; Fargate; Lambda | EC2 in one family and Region, any size, OS, tenancy or AZ | One instance type (with size flexibility for most Linux), one Region                      |
| Change the commitment | No (it applies itself to whatever runs)                          | No                                                        | Convertible: exchange; Standard: modify or sell                                           |
| Capacity reservation  | No                                                               | No                                                        | Only zonal Reserved Instances reserve capacity in their AZ                                |
| Covers other services | Fargate and Lambda                                               | No                                                        | No: each service has its own Reserved Instances (RDS, ElastiCache, Redshift, OpenSearch…) |

- **Other Savings Plans**: there are four types in all. Besides the two above, **Database Savings Plans** (up to 35 %, across Aurora, RDS, DynamoDB, ElastiCache and other database services; see [task 4.3](/d4/4-3-database-costs/)) and **SageMaker AI Savings Plans**.
- **Regional Reserved Instances** apply in any AZ of the Region and, for Linux/Unix (not RHEL or SUSE) with default tenancy, to any size in the family (a `large` reservation covers half an `xlarge`); a few GPU and HPC families are excluded. They don't reserve capacity.
- **Zonal Reserved Instances** reserve capacity in one AZ, for one exact instance type, with no size flexibility, and the capacity can't be shared with other accounts (Capacity Reservations can be).
- **Savings Plans don't reserve capacity.** For capacity in one AZ plus a discount, combine an On-Demand Capacity Reservation with a Savings Plan or regional Reserved Instance, which then bills the reserved capacity at the discounted rate.
- **Discounts are shared** across the accounts of an AWS Organizations organisation, unless the management account turns sharing off for an account or limits it to groups of accounts ([Domain 4 overview](/d4/#organising-and-reporting-spend)).
- **Choosing the amount**: Cost Explorer recommends a Savings Plan or Reserved Instance purchase from your recent usage, and its utilisation and coverage reports show whether the commitments you have are used. AWS Budgets can alert when utilisation or coverage drops ([Domain 4 overview](/d4/#cost-management-tools)).

## Spot Instances

Spot Instances use spare EC2 capacity at up to 90 % off. The price moves slowly with long-term supply and demand; there is no bidding. In exchange, EC2 can **interrupt** an instance when it needs the capacity back.

- **Two-minute warning.** An interruption notice comes through instance metadata and an EventBridge event two minutes before. An earlier **rebalance recommendation** signals that the instance is at higher risk, so the application can move work in time.
- **What happens on interruption**: terminate (the default), stop, or hibernate. Stop and hibernate need a persistent request or a fleet with maintained capacity, and an EBS-backed instance.
- **Maximum price** is optional and defaults to the On-Demand price. Setting a low maximum doesn't make Spot cheaper (you pay the current Spot price either way); it only makes interruptions more likely.
- **Requests**: a one-time request ends once it is filled; a persistent request launches again after an interruption. Cancelling an active request doesn't terminate its running instances: terminate them yourself.

**Spot-friendly designs**

- **Stateless workers** that pull jobs from an SQS queue: an interrupted job becomes visible again and another worker picks it up.
- **Checkpoints** to S3 or EFS for long jobs, so a restart continues where it stopped instead of starting over.
- **Be flexible about capacity.** Allow many instance types (or choose by attributes such as vCPUs and memory) and every AZ. Each type in each AZ is a separate Spot pool; more pools mean fewer interruptions and fewer launch failures.
- **Use the price-capacity-optimized allocation strategy**: it picks the pools least likely to be interrupted, then the cheapest of those. Lowest-price alone tends to pick the pools that are interrupted most.
- **Capacity Rebalancing** in an Auto Scaling group (or EC2 Fleet) tries to launch a replacement in a lower-risk pool when a rebalance recommendation arrives, then terminates the instance at risk once the new one is healthy.
- **Spot Placement Score** rates how likely a Spot request is to succeed in each Region or AZ, and the Spot Instance Advisor shows past interruption frequency per type.
- **Not for Spot**: databases with a single primary, stateful applications that can't lose a node, anything with a fixed deadline and no retry, and tightly coupled jobs that fail when one node is lost. Loosely coupled HPC fits Spot well, but the HPC optimised types (Hpc6a, Hpc7g…) aren't sold as Spot.

| Tool                                 | What it launches                                                                | Use it for                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Auto Scaling group (mixed instances) | On-Demand and Spot across several types and AZs, with scaling and health checks | Most fleets: web tiers, workers, anything that scales                                                                     |
| EC2 Fleet                            | A one-off or maintained mix of On-Demand and Spot across pools                  | Launching a set capacity in one call, without scaling policies                                                            |
| Spot Fleet                           | Spot (and optionally On-Demand) across launch pools                             | Legacy API with no planned investment: use an Auto Scaling group or EC2 Fleet instead (exam questions may still offer it) |
| AWS Batch, EMR, ECS, EKS             | Spot capacity under their own schedulers                                        | Batch jobs, task nodes, container capacity providers                                                                      |

## Mixing purchasing options in one fleet

A typical cost-optimised fleet has three layers: a **commitment** for the load that never goes away, **On-Demand** for the part that must not be interrupted, and **Spot** for the rest.

An Auto Scaling group with a **mixed instances policy** builds that in one group:

- **On-Demand base capacity**: the first instances the group launches are On-Demand (for example, the 6 instances that must always run). Cover them with a Savings Plan or Reserved Instances.
- **On-Demand percentage above base**: how the capacity above the base is split; 0 % means everything above the base is Spot.
- **Several instance types** (or attribute-based selection), so that Spot capacity can come from many pools.

Containers do the same with capacity provider strategies: on ECS, a **base** of tasks on `FARGATE` and a **weight** that sends the rest to `FARGATE_SPOT` (up to 70 % off; tasks get a two-minute warning and a SIGTERM). Fargate Spot runs Linux tasks only, on x86 or arm64, not Windows. EKS uses managed node groups or Karpenter node pools with Spot capacity.

- **Fargate Spot** has no fallback: if there is no Spot capacity, the tasks wait. Keep a base on regular Fargate for what must keep running.
- Scaling policies themselves ([task 2.1](/d2/2-1-scalable-loosely-coupled/), [task 3.2](/d3/3-2-compute/#scaling-compute-elastically)) save money too: the cheapest instance is the one that isn't running, so scale in when the load drops.

## Right-sizing and Graviton

Right-sizing means choosing the smallest instance type and size that still meets the load, then checking again as the load changes. Families and their uses are in [task 3.2](/d3/3-2-compute/#ec2-instance-families-and-sizing).

- **Right-size before you commit.** A Savings Plan bought for oversized instances locks in the waste for one or three years. Use **AWS Compute Optimizer** ([Domain 4 overview](/d4/#cost-management-tools); memory use needs the CloudWatch agent) first, then buy the commitment for what is left.
- **Pick the family by what runs out first.** A memory-bound application on a bigger M instance pays for vCPUs it never uses; a smaller R instance gives the same memory for less. The same goes for CPU-bound work on C instances.
- **Graviton** (Arm) instances cost up to 20 % less than comparable x86 instances and give better price performance, if the software builds for arm64. Lambda functions and Fargate tasks on arm64 cost about 20 % less for the same duration too.
- **Current generation.** Moving off an old generation is often the cheapest fix ([task 3.2](/d3/3-2-compute/#ec2-instance-families-and-sizing)).
- **Bare metal** (`.metal`) sizes give the whole server with no hypervisor, for software that needs direct hardware access or runs its own hypervisor. For licences counted per core, Dedicated Hosts are usually the cheaper and simpler answer.
- **Burstable T instances** are cheap for low average CPU with short bursts. One that runs above its baseline most of the day pays for surplus credits in unlimited mode, and can cost more than an M instance of the same size ([task 3.2](/d3/3-2-compute/#ec2-instance-families-and-sizing)).
- **Horizontal over vertical.** Several smaller instances in an Auto Scaling group follow the load up and down; one big instance (vertical scaling) is paid for at its peak size all day, and changing its type needs a stop and start.
- **Lambda memory** ([task 3.2](/d3/3-2-compute/#lambda-sizing-and-edge-functions)): AWS Lambda Power Tuning (an open-source tool) runs a function at several memory settings to find the cheapest.

## Non-production and part-time workloads

Not every environment needs production availability. Decide per class of workload:

| Workload class                 | Typical choice                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Production, customer-facing    | Several AZs, a committed baseline, On-Demand for what can't be interrupted, Spot only for spare capacity |
| Development and test           | One AZ, smaller instances, Spot where possible, stopped outside working hours                            |
| Batch and analytics            | Spot (AWS Batch, EMR task nodes), run when capacity is cheap, retries                                    |
| Rarely used tools and webhooks | Lambda or Fargate instead of an instance that idles all day                                              |

- **Stop it when nobody uses it.** A development fleet used 12 hours a day on weekdays runs 60 of the week's 168 hours: stopping it the rest of the time saves about 64 % of its instance cost. **Instance Scheduler on AWS** (an AWS Solution deployed with CloudFormation, not a service) starts and stops EC2 instances, Auto Scaling groups and RDS instances by tag on schedules; Auto Scaling **scheduled actions** do the same for a group, and an EventBridge Scheduler schedule can call the start and stop APIs.
- **Hibernation** lets a stopped development instance come back with its memory, so stopping it overnight doesn't cost a long start in the morning. While it is hibernated you pay only for its EBS volumes (including the saved memory) and any Elastic IP addresses.
- **Commitments don't fit part-time use.** A Savings Plan bills every hour, so for an environment that runs 36 % of the time, stopping it usually saves more than discounting it.

## EC2, containers or Lambda: which is cheapest?

| Workload                                                           | Usually cheapest                                                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event-driven, a few thousand short requests a day, idle in between | Lambda: nothing to pay while idle                                                                                                                       |
| Spiky API traffic with short requests                              | Lambda, or Fargate if each request is heavy or long                                                                                                     |
| Containers with uneven load and no servers to manage               | Fargate, scaled on the load, with Fargate Spot for interruptible tasks                                                                                  |
| Many containers with a high, steady load                           | ECS or EKS on EC2, packed densely, with a Savings Plan and Spot                                                                                         |
| Steady 24/7 load on servers                                        | EC2 with a Savings Plan or Reserved Instances                                                                                                           |
| Long batch jobs that can be retried                                | AWS Batch on Spot (EC2 or Fargate)                                                                                                                      |
| Small changes to every viewer request at the edge                  | CloudFront Functions: one sixth of the Lambda@Edge request price and no duration charge ([task 3.2](/d3/3-2-compute/#lambda-sizing-and-edge-functions)) |

- **Lambda costs grow with traffic.** It is cheapest at low or uneven traffic. At a constant high rate, the same work on containers or instances that run near full use can cost less: compare GB-seconds with the hourly price of the capacity that would do the work.
- **Provisioned concurrency** is billed for every hour it is set, used or not: schedule it with Application Auto Scaling for the hours it is needed.
- **Fargate costs more per vCPU than EC2**, but you pay only for the task sizes you ask for, with no idle instance capacity and no hosts to run. For a small or uneven fleet that usually wins; for a large, steady one, EC2 packed with tasks wins.
- **Compute Savings Plans cover Lambda and Fargate too**, so moving work from EC2 to serverless doesn't waste the commitment.
- **EKS adds a per-cluster fee.** Many small clusters cost more than a few shared ones. A cluster on a Kubernetes version past standard support pays a much higher extended-support fee until it is upgraded.

## Load balancers, licences and location

- **Load balancers** bill per hour plus per capacity unit (LCU for ALB, NLCU for NLB, GLCU for Gateway Load Balancer). One **ALB** (layer 7) can serve many services with host-based and path-based rules, so a dozen microservices don't need a dozen load balancers. Choose an **NLB** (layer 4) for TCP and UDP or very high throughput, and a **Gateway Load Balancer** only for inline network appliances. The ELB types are compared in [task 2.2](/d2/2-2-high-availability/#alb-and-auto-scaling-across-two-azs).
- **Licence-included or bring your own.** Windows and SQL Server licences can be included in the hourly price. Licences you already own (BYOL) that are counted per socket or physical core need **Dedicated Hosts**; **AWS License Manager** tracks the licences and the hosts they use. Dedicated Instances don't show sockets and cores, so they don't help with core-based licences.
- **Regions differ in price.** The same instance type costs more in some Regions than in others. Where latency, data residency and the services needed allow, running batch or internal work in a cheaper Region lowers the bill (watch the cost of moving data between Regions, [task 4.4](/d4/4-4-network-costs/)).
- **Compute at the edge.** CloudFront Functions and Lambda@Edge answer or change requests at edge locations, so fewer requests reach origin servers. **Local Zones** and **Wavelength Zones** put compute close to users or inside 5G networks; they cost more than the parent Region and are for latency, not savings.
- **Hybrid**: **AWS Outposts** racks are bought for a three-year term (all, partial or no upfront) and billed whether used or not, so they are for workloads that must stay on premises, not a way to save money. **ECS Anywhere** and **EKS Anywhere** run containers on servers you already own, with the same tools as in AWS.

## If the exam says… → think…

| If the exam says…                                                         | Think…                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Steady 24/7 load for 3 years, lowest cost, instance family may change     | Compute Savings Plan (3 years, All Upfront for the most discount)                                                       |
| Steady use of one instance family in one Region, maximum discount         | EC2 Instance Savings Plan (or Standard Reserved Instances)                                                              |
| Commitment must also cover Fargate and Lambda                             | Compute Savings Plan                                                                                                    |
| Capacity must be guaranteed in one AZ for a known event                   | On-Demand Capacity Reservation, future-dated if needed (add a Savings Plan only if the usage is steady after the event) |
| Need a discount and reserved capacity in one AZ, one exact type           | Zonal Reserved Instance (or a Capacity Reservation plus a Savings Plan)                                                 |
| Reserved Instances the company no longer needs                            | Sell Standard Reserved Instances on the Reserved Instance Marketplace                                                   |
| Batch jobs that can restart, finish by morning, lowest cost               | Spot Instances (AWS Batch on Spot), with retries                                                                        |
| Spot Instances in a group are interrupted too often                       | More instance types and AZs, price-capacity-optimized allocation                                                        |
| Replace Spot instances before they are interrupted                        | Capacity Rebalancing on the Auto Scaling group                                                                          |
| Minimum always-on capacity plus cheap extra capacity at peak              | Mixed instances policy: On-Demand base, Spot above it                                                                   |
| ECS on Fargate, some tasks must always run, the rest can be interrupted   | Capacity provider strategy: base on FARGATE, weight on FARGATE_SPOT                                                     |
| Licence counted per physical core, auditors need to see sockets and cores | Dedicated Hosts                                                                                                         |
| Hardware not shared with other customers, no licence constraints          | Dedicated Instances                                                                                                     |
| Instances sized by guesswork, find smaller types from real use            | AWS Compute Optimizer (with the CloudWatch agent for memory)                                                            |
| Cheaper instances for software that builds for arm64                      | Graviton instance types                                                                                                 |
| T instance in unlimited mode runs hot all day and the bill is high        | Move it to an M or C instance                                                                                           |
| Memory-bound app on a large general purpose instance with idle CPU        | A smaller memory optimised (R) instance                                                                                 |
| Development instances only used in working hours                          | Stop them on a schedule (Instance Scheduler on AWS)                                                                     |
| Server idles at a few % CPU to answer short webhook calls                 | Lambda                                                                                                                  |
| Many microservices, each behind its own ALB                               | One ALB with host- or path-based routing rules                                                                          |
| Lambda function waits on provisioned concurrency that is idle at night    | Schedule provisioned concurrency with Application Auto Scaling                                                          |

## Common traps

- **A Savings Plan doesn't reserve capacity**, and neither does a regional Reserved Instance. Zonal Reserved Instances, On-Demand Capacity Reservations and Capacity Blocks for ML do.
- **A Capacity Reservation alone is billed at the full On-Demand rate**, even when nothing runs in it.
- **Commitments are hourly.** Commit only to the baseline; a commitment sized for the peak is unused most hours.
- **Savings Plans can't be sold or cancelled.** Only a plan of $100 an hour or less, bought in the last 7 days and in the same calendar month, can be returned. Standard Reserved Instances can be sold on the Marketplace; Convertible ones can't, but can be exchanged.
- **Spot Instances get no Savings Plan or Reserved Instance discount**, and Capacity Blocks for ML don't either.
- **EC2 Instance Savings Plans are tied to one family in one Region.** Moving to Graviton (another family) or another Region needs a Compute Savings Plan.
- **Spot isn't bidding.** A lower maximum price doesn't lower what you pay, only raises the chance of interruption.
- **Cancelling a Spot request doesn't stop its instances.** Terminate them too.
- **Fargate Spot doesn't fall back to Fargate.** Without a base on regular Fargate, tasks wait for capacity.
- **Dedicated Instances aren't Dedicated Hosts.** Only Dedicated Hosts show sockets and physical cores for licensing.
- **A stopped instance still pays** for its EBS volumes and Elastic IP addresses.
- **Right-size before you buy a commitment**, or you pay for the waste for years.
- **Lambda isn't always cheapest.** At a constant high load, instances or containers running near full use can cost less.
- **Outposts don't save money.** They are for data or latency that must stay on premises.

## Links

**AWS documentation**

- [Amazon EC2 billing and purchasing options](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-purchasing-options.html) and [Reserved Instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-reserved-instances.html)
- [What are Savings Plans?](https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html) and [Savings Plans types](https://docs.aws.amazon.com/savingsplans/latest/userguide/plan-types.html)
- [Spot Instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-instances.html), [Spot Instance interruptions](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-interruptions.html) and [best practices for EC2 Spot](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-best-practices.html)
- [Auto Scaling groups with multiple instance types and purchase options](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-mixed-instances-groups.html) and [Capacity Rebalancing](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-capacity-rebalancing.html)
- [On-Demand Capacity Reservations](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-capacity-reservations.html) and [Dedicated Hosts](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/dedicated-hosts-overview.html)
- [Amazon ECS capacity providers for Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html)
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/) and [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/)
- [Instance Scheduler on AWS](https://docs.aws.amazon.com/solutions/instance-scheduler-on-aws/)

**Practice**

- [Practice tests](/practice/): in the **Practice** card, choose **Practice by: Task** and then **4.2** to drill only this task.
