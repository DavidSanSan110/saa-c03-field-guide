---
title: 'Task 3.4: Determine high-performing and/or scalable network architectures'
description: 'CloudFront caching and Origin Shield, Global Accelerator compared with CloudFront, Route 53 latency, geoproximity and IP-based routing and hybrid DNS, choosing a load balancer for performance, VPC address planning and connecting many VPCs (peering, Transit Gateway, PrivateLink, Cloud WAN), and Direct Connect and Site-to-Site VPN throughput and resiliency, with exam cues and common traps.'
---

Network questions in this task describe where users and data are (players on every continent, a data centre that replicates every night, forty VPCs in a dozen accounts) and ask how traffic gets there fast and keeps getting there as the system grows. Work from the outside in. **Edge**: can the content be cached close to users (CloudFront), or does the connection itself need a faster path (Global Accelerator)? **DNS**: which Region should answer each user (Route 53)? **Entry point**: which load balancer reads the traffic it has to route? **Inside AWS**: is the address space big enough, and how do VPCs and on-premises networks connect at scale? Subnets, routes, gateways and endpoints are in [task 1.2](/d1/1-2-secure-workloads/), failover and health checks in [task 2.2](/d2/2-2-high-availability/), and data transfer costs are task 4.4.

Part of [Domain 3: Design High-Performing Architectures](/d3/).

## Edge networking: CloudFront

**Amazon CloudFront** is a content delivery network. Viewers connect to the nearest of hundreds of edge locations, which answer from their cache when they can and otherwise fetch from the origin over the AWS network. **Regional edge caches** sit between the edge locations and the origin and keep objects that have dropped out of the smaller edge caches.

- **The cache hit ratio is the main lever.** The **cache key** (by default the domain name and URL path) decides how many copies of an object exist. A **cache policy** adds only the headers, cookies and query strings that really change the response; every extra value splits the cache and sends more requests to the origin. Values the origin needs but that don't change the response go in an **origin request policy** instead.
- **TTLs**: CloudFront follows the origin's `Cache-Control` and `Expires` headers within the minimum and maximum TTL of the cache policy. Without those headers, objects stay for the policy's default TTL (24 hours in the managed `CachingOptimized` policy).
- **Origin Shield** adds one more caching layer, in a Region you choose close to the origin. All edge locations and regional edge caches then fetch through it, so the origin gets fewer requests and the hit ratio goes up: useful when viewers are spread around the world, for live video, and for origins with limited capacity, including on premises.
- **Invalidations** remove files from the caches before their TTL ends, by path or with a wildcard (`/images/*`). For files that change often, **versioned file names** (`app.v42.js`) work better: nothing to wait for, and the old and new versions can be cached side by side.
- **Dynamic content gets faster too.** TLS ends at the edge, close to the viewer, and CloudFront reuses its connections to the origin over the AWS network. Responses that must not be cached use the managed `CachingDisabled` policy. CloudFront supports HTTP/2, HTTP/3 and WebSockets, and compresses files with Gzip or Brotli.
- **Origins**: S3 buckets, load balancers and EC2 instances (also in private subnets, through VPC origins), API Gateway, and any HTTP server, including on premises. Restricting access to the origin (OAC, VPC origins) is in [task 1.2](/d1/1-2-secure-workloads/). An **origin group** fails over to a second origin when the first returns an error code you choose or can't be reached, for GET, HEAD and OPTIONS requests.
- **Code at the edge**: CloudFront Functions and Lambda@Edge are compared in [task 3.2](/d3/3-2-compute/).
- **CloudFront or S3 Cross-Region Replication?** CloudFront caches for a TTL at every edge location, which suits static content read all over the world. Cross-Region Replication keeps full copies of a bucket in the Regions you choose, updated in near real time, for data that changes often and must be read with low latency in a few Regions. Faster long-distance **uploads** to one bucket are S3 Transfer Acceleration, in [task 3.1](/d3/3-1-storage/).

## Global Accelerator or CloudFront

**AWS Global Accelerator** gives an application two static anycast IPv4 addresses (plus two IPv6 addresses for a dual-stack accelerator). Clients connect to the nearest edge location, and the traffic then crosses the AWS global network to the closest healthy endpoint instead of the public internet. It doesn't cache anything: it carries TCP and UDP connections to your endpoints.

|             | CloudFront                                                                     | Global Accelerator                                                                    |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Traffic     | HTTP and HTTPS, including WebSockets                                           | Any TCP or UDP                                                                        |
| Caching     | Yes, at edge locations and regional edge caches                                | No: every request reaches an endpoint                                                 |
| Addresses   | A DNS name whose IP addresses change (static anycast IP lists only on request) | Two static anycast IPs (four with dual stack), kept for the life of the accelerator   |
| Backends    | Origins: S3, load balancers, EC2, API Gateway, any HTTP server                 | ALBs, NLBs, EC2 instances and Elastic IPs in one or more Regions                      |
| Failover    | Per request, between the two origins of an origin group                        | Health checks move traffic between endpoints and Regions, with no DNS cache to expire |
| Pick it for | Websites, APIs, downloads, video: static and dynamic HTTP content              | Gaming, IoT and VoIP over UDP, fixed IPs for allow lists, fast multi-Region failover  |

- **Standard accelerator**: listeners (ports and protocols) send traffic to one **endpoint group** per Region. The **traffic dial** (0 to 100 %) limits how much of the traffic headed for a Region's endpoint group that group accepts; the rest goes to other Regions. It is used for blue/green moves between Regions or to drain a Region before maintenance. **Endpoint weights** split traffic inside a group. **Client affinity** by source IP keeps a client on the same endpoint for stateful applications.
- **Endpoints can be private**: an internal ALB or NLB, or instances in private subnets, with no public IP of their own (the VPC still needs an internet gateway). With **client IP preservation** on (ALBs, EC2 instances, and NLBs with security groups), the application sees the client's own IP address.
- **Custom routing accelerators** map ports on the accelerator to specific EC2 instances and ports in your subnets, so your own logic, such as a game's matchmaking service, can send each user to one particular instance.
- Both services use the same edge network and get AWS Shield Standard against DDoS attacks; Shield Advanced and WAF are in [task 1.2](/d1/1-2-secure-workloads/).

## Route 53 routing for performance

Route 53 decides which endpoint a user reaches before any connection starts. All the routing policies, health checks and DNS failover are in [task 2.2](/d2/2-2-high-availability/); these are the ones that serve performance.

| Routing policy | Chooses by                                                             | Use it for                                                                                                          |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Latency        | Latency measured over time between users' networks and each AWS Region | A multi-Region application where each user should reach the fastest Region                                          |
| Geoproximity   | Distance between users and resources, enlarged or shrunk with a bias   | Moving the border between Regions' service areas, such as sending more nearby users to a Region with spare capacity |
| IP-based       | The client's IP range, from CIDR collections you upload                | Sending known networks (an ISP, a company) to a chosen endpoint                                                     |
| Geolocation    | The user's continent, country or US state                              | Language, content rights or data residency; it doesn't pick the fastest Region                                      |

- **Latency** is measured to AWS Regions, not to your endpoints, and it changes: a user in Germany can be sent to a US Region if that is faster from their network that week.
- **Geoproximity bias** goes from -99 to 99: a positive bias grows the area that a resource serves, a negative one shrinks it. AWS resources are placed by Region (or Local Zone group), others by latitude and longitude.
- **IP-based routing** helps when you know your users' networks better than the latency data does, for example to keep an ISP's customers on the endpoint closest to that ISP.
- **Alias records** point the zone apex (`example.com`) at CloudFront, load balancers, Global Accelerator, S3 website endpoints and more, and alias queries to AWS resources are free.
- **TTL**: with a long TTL, resolvers answer from their cache and send fewer queries, but changes reach clients more slowly. Global Accelerator avoids that trade-off, because its IP addresses stay the same.
- **Hybrid DNS**: the **Route 53 Resolver** (now called Route 53 VPC Resolver in the docs) answers DNS queries in every VPC. When a data centre is connected by VPN or Direct Connect, an **inbound endpoint** lets the on-premises DNS servers resolve names in the VPC and its private hosted zones. An **outbound endpoint** with **forwarding rules** sends queries for on-premises domains (`corp.example`) from the VPC to the corporate DNS servers. Rules can be shared with other accounts through AWS RAM.

## Choosing a load balancer

The comparison of ALB, NLB and Gateway Load Balancer, health checks and cross-zone load balancing are in [task 2.2](/d2/2-2-high-availability/). For performance, the choice is about which layer the load balancer has to read.

- **Application Load Balancer** (layer 7) reads each HTTP request. Listener rules route by path, host name, headers, query string, method or source IP to different target groups, so one ALB can front many microservices. Targets are instances, IP addresses (including on-premises servers over VPN or Direct Connect) and Lambda functions; ECS tasks register with their dynamic host ports ([task 3.2](/d3/3-2-compute/)).
- **ALB routing algorithms**: round robin by default; **least outstanding requests** sends each new request to the target with the fewest requests in progress, which suits requests that vary a lot in cost; **weighted random** is the third option. **Slow start** gives new targets a growing share of traffic for a set time, so their caches warm up first; it works only with round robin.
- **Network Load Balancer** (layer 4) forwards connections without reading them: millions of requests per second with very low latency, TCP, UDP, TLS and QUIC, one static IP per AZ (optionally an Elastic IP when internet-facing), and the client's source IP preserved for instance targets. It is the provider side of PrivateLink, and it can have an ALB as its target when an application needs both static IPs and HTTP routing.
- **Both scale automatically.** For a known spike, such as a launch or a ticket sale, **LCU reservation** sets a minimum capacity on an ALB or NLB in advance.
- **A load balancer is regional.** For a multi-Region application, put one in each Region behind Route 53 latency records or Global Accelerator.
- The **Classic Load Balancer** is previous generation; new designs use ALB or NLB.

## VPC design at scale

How a VPC is built (subnet tiers, route tables, NAT gateways, endpoints) is in [task 1.2](/d1/1-2-secure-workloads/). At scale, the questions are about room to grow and about how many VPCs and networks connect.

- **Multi-tier layout**: a public subnet tier for the load balancers, a private tier for the application and an isolated tier for the databases (subnet types are in [task 1.2](/d1/1-2-secure-workloads/)), each with one subnet in every AZ the application uses. Put the Region close to the users or the data, and keep tiers that talk constantly in the same Region.
- **Plan the address space first.** A VPC's IPv4 CIDR is between /16 and /28 and can't be resized; you add secondary CIDRs instead (5 IPv4 CIDRs per VPC by default, the primary included; adjustable up to 50). AWS keeps 5 addresses in every subnet (the first four and the last), so 29 instances need a /26 (59 usable), not a /27 (27 usable).
- **Leave room for growth**: more instances during scaling, one IP per EKS pod by default, more AZs later. Ranges that may ever be connected (other VPCs, on premises) must not overlap. **Amazon VPC IPAM** plans, allocates and tracks CIDRs across accounts and Regions.
- **IPv6**: a VPC always has IPv4 and can add IPv6 for dual stack. An "insufficient addresses" error in a dual-stack subnet means IPv4 ran out: add a secondary IPv4 CIDR and a new subnet.

| Option          | Shape                                                   | Performance and scale                                                                                               | Pick it for                                                     |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| VPC peering     | A direct link between two VPCs                          | No extra hop and no bandwidth limit of its own; not transitive, so N VPCs need N(N-1)/2 links                       | A few VPCs that exchange a lot of traffic at the lowest latency |
| Transit Gateway | A regional hub for VPCs, VPNs and Direct Connect        | Transitive routing for thousands of attachments, up to 100 Gbps per VPC attachment in each AZ; peers across Regions | Many VPCs and accounts, plus on-premises networks               |
| PrivateLink     | Interface endpoints to one service behind an NLB        | One way: consumers reach only that service; overlapping CIDRs don't matter                                          | Offering one service to many VPCs or customers                  |
| AWS Cloud WAN   | A global network built from one central policy          | Connects Regions and on-premises sites, with segments that keep traffic apart                                       | A global network across many Regions                            |
| VPC sharing     | Several accounts launch into subnets of one VPC via RAM | Nothing to connect: the workloads share one VPC                                                                     | Fewer VPCs to manage, with a central network team               |

- **Transit Gateway** is the AWS service for **IP multicast** between instances (segmentation with route tables and sharing with RAM are in [task 1.2](/d1/1-2-secure-workloads/)). Every packet takes one more hop and is charged per GB, so two VPCs with heavy traffic between them can still use peering next to it.
- **Amazon VPC Lattice** connects services at the application layer (HTTP, HTTPS, gRPC and TLS, plus TCP to resources) across VPCs and accounts, with its own access policies, without peering or a transit gateway.
- **Placement close to users** (Local Zones, Wavelength, Outposts), placement groups and enhanced networking (ENA, EFA) are in [task 3.2](/d3/3-2-compute/).

## Hybrid connectivity: Direct Connect and Site-to-Site VPN

What each option is and how to encrypt Direct Connect are in [task 1.2](/d1/1-2-secure-workloads/). For performance, compare bandwidth, how steady the latency is, and how long the link takes to set up.

|                | Site-to-Site VPN                                                                          | Direct Connect                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Path           | IPsec tunnels over the internet                                                           | A private connection through a Direct Connect location                           |
| Bandwidth      | Up to 1.25 Gbps per tunnel, two tunnels per connection; large bandwidth tunnels go higher | Dedicated: 1, 10, 100 or 400 Gbps. Hosted, through a partner: 50 Mbps to 25 Gbps |
| Latency        | Changes with the internet                                                                 | Consistent                                                                       |
| Time to set up | Minutes                                                                                   | Weeks or more                                                                    |
| Encryption     | Yes                                                                                       | No, unless you add a VPN over it, or MACsec (dedicated 10, 100 or 400 Gbps only) |

- **More VPN bandwidth**: all VPN connections on one virtual private gateway share about 1.25 Gbps toward on premises, so extra connections to it don't add bandwidth. Attach the VPN connections to a **transit gateway** with BGP and turn on **ECMP**: traffic then spreads over every tunnel of every connection, and all attached VPCs can use it.
- **Large bandwidth tunnels** (up to 5 Gbps each) work on transit gateway and Cloud WAN attachments, not on a virtual private gateway.
- **Accelerated Site-to-Site VPN** carries the tunnels from the nearest AWS edge location over the AWS network through Global Accelerator, which helps distant sites with unstable internet paths. It needs a transit gateway; a virtual private gateway doesn't support it.
- **Virtual interfaces**: a **private VIF** reaches VPCs through a virtual private gateway or a Direct Connect gateway; a **transit VIF** reaches transit gateways through a Direct Connect gateway; a **public VIF** reaches AWS public endpoints such as S3 in every Region.
- **Direct Connect gateway**: a global resource that links Direct Connect connections to VPCs or transit gateways in many Regions and accounts. It doesn't route traffic between the VPCs attached to it.
- **More capacity on one link**: a **LAG** bundles up to four dedicated connections of the same speed (two at 100 or 400 Gbps) on the same Direct Connect device into one logical connection. **SiteLink** sends traffic between your own sites through Direct Connect locations, without going through a Region.
- **Resiliency**: one connection is a single point of failure. **High resiliency** is one connection at each of two locations; **maximum resiliency** is two connections on separate devices at each of at least two locations. A Site-to-Site VPN is the low-cost backup for Direct Connect.
- **Lead time**: if the link is needed this week, start with a VPN and add Direct Connect later. A one-time bulk copy that the network can't finish in time is a data transfer question ([task 3.1](/d3/3-1-storage/)).
- **AWS Client VPN** connects individual users' devices, not whole sites.

## If the exam says… → think…

| If the exam says…                                                        | Think…                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Static and dynamic web content for users worldwide, with low latency     | CloudFront                                                                              |
| The origin gets too many requests from many edge locations               | Origin Shield, and a cache policy with fewer cache key values                           |
| Low cache hit ratio because every header and cookie is forwarded         | A cache policy with only the values that change the response                            |
| A changed file must be served right away                                 | Invalidation, or versioned file names                                                   |
| Data changes often and must be read with low latency in two Regions      | S3 Cross-Region Replication, not CloudFront                                             |
| UDP game, IoT or VoIP traffic from users worldwide                       | Global Accelerator                                                                      |
| Two fixed IP addresses for an application in several Regions             | Global Accelerator                                                                      |
| Fast regional failover (under a minute) that doesn't wait for DNS caches | Global Accelerator health checks                                                        |
| Move traffic from one Region to another a little at a time               | Lower the old Region's Global Accelerator traffic dial, or Route 53 weighted records    |
| Each player must reach one specific game server instance                 | Global Accelerator custom routing accelerator                                           |
| Users on several continents must reach the lowest-latency Region         | Route 53 latency routing (or Global Accelerator for TCP/UDP)                            |
| Send more users to one Region, based on where they are                   | Route 53 geoproximity routing with a positive bias                                      |
| Users of one ISP must go to a chosen endpoint                            | Route 53 IP-based routing                                                               |
| On-premises servers must resolve names in a private hosted zone          | Route 53 Resolver inbound endpoint                                                      |
| VPC instances must resolve the company's on-premises domain names        | Route 53 Resolver outbound endpoint with a forwarding rule                              |
| Route `/api` and `/images` to different services behind one address      | ALB path-based routing                                                                  |
| Millions of TCP or UDP requests per second at very low latency           | Network Load Balancer                                                                   |
| Static IPs in front of HTTP path routing                                 | NLB with an ALB target, or Global Accelerator in front of the ALB                       |
| A load balancer must take a planned traffic spike from the first second  | LCU reservation                                                                         |
| Requests vary a lot in processing time and some targets overload         | ALB least outstanding requests routing                                                  |
| Dozens of VPCs in many accounts plus on premises need transitive routing | Transit Gateway shared with AWS RAM                                                     |
| Multicast between instances                                              | Transit Gateway multicast                                                               |
| Expose one service to many VPCs with overlapping CIDRs                   | PrivateLink (NLB and interface endpoints)                                               |
| A subnet has run out of IPv4 addresses                                   | Add a secondary IPv4 CIDR to the VPC and create a new subnet                            |
| About 10 Gbps over VPN to many VPCs                                      | Several VPN connections to a transit gateway with ECMP, or large bandwidth tunnels      |
| Distant branch offices see jitter on their VPN                           | Accelerated Site-to-Site VPN                                                            |
| A steady, high-bandwidth private link to AWS                             | Direct Connect                                                                          |
| Connectivity is needed within days                                       | Site-to-Site VPN (Direct Connect takes weeks)                                           |
| One Direct Connect connection to VPCs in several Regions                 | Direct Connect gateway                                                                  |
| Direct Connect must survive the loss of a whole location                 | Connections at two or more locations (maximum resiliency: two at each of two locations) |
| Low-cost backup for Direct Connect                                       | Site-to-Site VPN                                                                        |

## Common traps

- **CloudFront is HTTP only.** UDP and other non-HTTP protocols are a Global Accelerator question.
- **Global Accelerator doesn't cache.** Repeated downloads of the same files are a CloudFront question.
- **Every value in the cache key splits the cache.** Forwarding all headers, cookies or query strings lowers the hit ratio.
- **Latency routing isn't geographic.** It follows measured latency to Regions, which can send a user to a distant Region; geolocation doesn't pick the fastest Region either.
- **DNS changes wait for TTLs.** For failover that doesn't depend on client caches, use Global Accelerator.
- **An ALB has no static IP address.** Use an NLB, or Global Accelerator in front of the ALB.
- **An ALB doesn't carry UDP, and an NLB doesn't route by path.**
- **Extra VPN connections to a virtual private gateway don't add bandwidth.** ECMP needs a transit gateway.
- **Direct Connect isn't quick to set up.** It takes weeks; start with a VPN if the link is needed now.
- **A hosted connection stops at 25 Gbps.** 100 or 400 Gbps needs a dedicated connection.
- **One Direct Connect connection, or one location, is a single point of failure.**
- **A Direct Connect gateway doesn't route between VPCs.** VPC-to-VPC traffic needs peering or a transit gateway.
- **A VPC CIDR can't be resized**, and every subnet loses 5 addresses. Add a secondary CIDR when space runs out.
- **Transit Gateway adds a hop and a per-GB charge.** It is the answer for many VPCs, not automatically the fastest link between two.

## Links

**AWS documentation**

- [What is Amazon CloudFront?](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html), [the cache key](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-the-cache-key.html) and [Origin Shield](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/origin-shield.html)
- [What is AWS Global Accelerator?](https://docs.aws.amazon.com/global-accelerator/latest/dg/what-is-global-accelerator.html)
- [Route 53 routing policies](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html) and [Route 53 Resolver](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver.html)
- [Application Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html) and [Network Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/introduction.html)
- [Building a scalable and secure multi-VPC network infrastructure](https://docs.aws.amazon.com/whitepapers/latest/building-scalable-secure-multi-vpc-network-infrastructure/welcome.html), [Transit Gateway](https://docs.aws.amazon.com/vpc/latest/tgw/what-is-transit-gateway.html) and [VPC IPAM](https://docs.aws.amazon.com/vpc/latest/ipam/what-it-is-ipam.html)
- [What is AWS Direct Connect?](https://docs.aws.amazon.com/directconnect/latest/UserGuide/Welcome.html), [the resiliency toolkit](https://docs.aws.amazon.com/directconnect/latest/UserGuide/resiliency_toolkit.html) and [Site-to-Site VPN quotas](https://docs.aws.amazon.com/vpn/latest/s2svpn/vpn-limits.html)

**Practice**

- [Practice tests](/practice/): in the **Practice** card, choose **Practice by: Task** and then **3.4** to drill only this task.
