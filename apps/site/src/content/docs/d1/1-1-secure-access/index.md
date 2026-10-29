---
title: 'Task 1.1: Design secure access to AWS resources'
description: 'IAM identities and policies, how AWS evaluates a request, cross-account access, Organizations and SCPs, IAM Identity Center, Directory Service, Cognito and auditing access, with exam cues and common traps.'
---

This task is about one question: **who may call which API on which resource, and what decides it.** Almost every answer is a mix of the same few pieces: an identity, a policy, temporary credentials and, with many accounts, a guardrail set by the organization.

Part of [Domain 1: Design Secure Architectures](/d1/).

## IAM identities and policies

IAM is a global service: users, roles and policies are not tied to a Region. The **root user** owns the account and can do everything, so it is kept for the few tasks that really need it, protected with MFA and given no access keys. People get their own identity (one person, one identity, never shared), and workloads such as EC2 instances or Lambda functions get a **role**, never stored keys.

| Identity  | What it is                                   | Credentials                                                | Typical use                                                                        |
| --------- | -------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Root user | The account owner                            | Email + password, plus MFA                                 | Account and billing tasks that only root can do                                    |
| IAM user  | A long-lived identity for one person or app  | Password for the console, access keys for the CLI and SDKs | When federation is not possible                                                    |
| IAM group | A set of users                               | None (it can't sign in or be a principal)                  | Attach a policy once for a whole team                                              |
| IAM role  | An identity that trusted principals _assume_ | Temporary credentials from AWS STS                         | EC2 instance profile, Lambda execution role, cross-account access, federated users |

A few rules that come up again and again:

- Groups contain **users only**. A group can't contain another group, but a user can be in several groups.
- A policy is a JSON document of statements with `Effect` (`Allow` or `Deny`), `Action`, `Resource` and an optional `Condition`. A `Principal` appears only in **resource-based** policies, because an identity-based policy is already attached to its principal.
- **Managed** policies are reusable (AWS managed or customer managed); **inline** policies live inside one user, group or role and are deleted with it.
- The console uses a password (plus MFA); the CLI and SDKs sign requests with an **access key ID + secret access key**. CloudShell is a browser shell that already has your console identity, so it needs no keys.
- MFA can be a passkey or FIDO security key, a virtual authenticator app, or a hardware TOTP token. An account **password policy** sets length, character types, rotation and reuse rules for IAM users.

Two built-in tools help with least privilege: the **credential report** (account-wide list of every user and the state of their password, access keys and MFA) and **last accessed information** (per user or role, which services it was allowed to use and when it last used them, so unused permissions can be removed).

## How a request is evaluated

Everything starts **denied**. A request is allowed only if some policy allows it, nothing denies it explicitly, and every guardrail that applies leaves room for it.

1. **Explicit deny?** If any applicable policy denies the action, the request is denied. Nothing overrides this.
2. **Organization guardrails.** In a member account, the SCPs (for the principal) and RCPs (for the resource) on every level from the organization root down to the account must allow the action.
3. **A grant.** An identity-based policy or a resource-based policy must allow it. Within one account either one is enough; across accounts **both** sides must allow it.
4. **Other limits.** A permissions boundary on the user or role, and a session policy passed when a role was assumed, can only take permissions away.

| Policy type          | Attached to                                                        | Grants? | What it does                                                           |
| -------------------- | ------------------------------------------------------------------ | :-----: | ---------------------------------------------------------------------- |
| Identity-based       | User, group or role                                                |   Yes   | What this identity may do                                              |
| Resource-based       | A resource: bucket, queue or KMS key policy, a role's trust policy |   Yes   | Who may use this resource; names a `Principal`, even in other accounts |
| Permissions boundary | User or role (not a group)                                         |   No    | The most that identity-based policies can give this user or role       |
| SCP                  | Organization root, OU or account                                   |   No    | Caps what any user or role in a member account can do                  |
| RCP                  | Organization root, OU or account                                   |   No    | Caps access to resources in member accounts (supported services)       |
| Session policy       | Passed with `AssumeRole` or federation                             |   No    | Narrows one session below the role's own permissions                   |

SCP = service control policy, RCP = resource control policy, both from AWS Organizations.

When no resource-based policy is involved, the effective permissions are the **intersection** of the identity-based policy and every limit that applies (boundary, SCP, session policy). A boundary that allows only S3 plus an identity policy that allows only `iam:CreateUser` gives **nothing**, because no action is in both.

Conditions make statements precise. The ones worth recognising:

| Condition key                             | Typical use                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `aws:SourceIp`                            | Deny calls that don't come from the company's IP ranges                                       |
| `aws:RequestedRegion`                     | Deny actions outside approved Regions                                                         |
| `aws:MultiFactorAuthPresent`              | Require MFA for sensitive actions such as stopping or terminating instances                   |
| `aws:PrincipalOrgID`                      | In a resource policy, allow any principal from your organization without listing account IDs  |
| `aws:PrincipalTag/…`, `aws:ResourceTag/…` | Attribute-based access control (ABAC): allow when the caller's tag matches the resource's tag |

For S3, bucket-level actions such as `s3:ListBucket` take the bucket ARN (`arn:aws:s3:::my-bucket`), while object actions such as `s3:GetObject` take the object ARN (`arn:aws:s3:::my-bucket/*`). Mixing them up gives a policy that looks right and denies everything.

## Cross-account access

There are two ways to let a principal in account A use a resource in account B.

|                          | Role in account B (the role is a proxy)                                                   | Resource-based policy in account B                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| How                      | B's role has a **trust policy** naming A; A's principal is allowed `sts:AssumeRole` on it | B's bucket, queue, topic or key policy names A (or a principal in A)                       |
| Credentials              | Temporary, from STS                                                                       | The caller's own                                                                           |
| Caller's own permissions | Given up for the session: it acts **only** as the role                                    | Kept: it can read in A and write in B in the same call flow                                |
| Works for                | Any service                                                                               | Only services whose resources support resource-based policies (S3, SQS, SNS, KMS, Lambda…) |

Either way, cross-account access needs an allow on **both** sides: the caller's account must allow the action (or the `AssumeRole`), and the resource's account must allow the caller. For example, a job in account A that reads its own queue and writes reports into a bucket in account B is simpler with a bucket policy in B: with a role it would lose access to its own queue while acting as the role.

**Role sessions.** `AssumeRole` returns credentials that last 1 hour by default, from 15 minutes up to the role's maximum session duration (1 to 12 hours). When one role session assumes another role (_role chaining_), the new session is capped at 1 hour.

**Third parties and the external ID.** When a vendor that serves many customers assumes a role in your account, someone else could hand the vendor your role ARN and trick it into acting on your account (the _confused deputy_ problem). The fix is an **external ID**: the vendor gives you a value that is unique to you, and your role's trust policy requires it with the `sts:ExternalId` condition. The vendor always sends the ID of the customer it is working for, so the other customer can't use your role. The external ID is not a secret and you don't make it up yourself; the vendor generates it.

**Services acting for you.** An AWS service also needs permission to reach its targets. An EventBridge rule, for example, writes to CloudWatch Logs through the log group's resource-based policy, can invoke Lambda or publish to SNS and SQS through either a resource-based policy or a role, and needs an IAM role for targets such as Kinesis Data Streams or ECS tasks.

## Many accounts: Organizations, SCPs and Control Tower

**AWS Organizations** groups accounts under one **management account**; all the others are **member accounts**, and an account belongs to only one organization at a time. Accounts sit in **organizational units (OUs)**, which can be nested (per environment, business unit or project). Benefits: consolidated billing with one payment method, volume pricing on the combined usage, Reserved Instance and Savings Plans discounts shared across accounts, an API to create accounts, and one place to set policies.

**SCPs** are the security side. They need the organization's _all features_ mode (not only consolidated billing).

- An SCP **never grants** anything. It sets a ceiling for every user and role in a member account, and the **root user of that account is not exempt**. Users still need IAM policies.
- The **management account is outside SCPs**, and so are **service-linked roles**.
- An action is available in an account only if it is allowed by an SCP on **every** level from the root down to the account. A deny at any level wins.
- Every root, OU and account starts with the AWS managed `FullAWSAccess` SCP. Removing it without a replacement blocks everything below.

| Strategy   | How                                                               | Good for                                                                                         |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Deny list  | Keep `FullAWSAccess`, add SCPs that deny specific actions         | Blocking a few risky things (leaving the organization, disabling CloudTrail, unapproved Regions) |
| Allow list | Replace `FullAWSAccess` with SCPs that allow only listed services | Tightly controlled OUs where only approved services may run                                      |

Organizations has other policy types too. **Tag policies** define allowed tag keys and values, report non-compliant resources and can block non-compliant tagging on supported resources; they help with cost allocation and ABAC.

A bucket policy with `aws:PrincipalOrgID` is the short way to say "any principal in our organization", and it keeps working when accounts are added.

**AWS Control Tower** sets up a multi-account environment (a _landing zone_) on top of Organizations in a few clicks, following AWS best practices, and keeps governing it with **controls** (formerly called guardrails), applied per OU:

| Control behaviour | Implemented with     | Example                                                  |
| ----------------- | -------------------- | -------------------------------------------------------- |
| Preventive        | SCPs (and RCPs)      | Disallow changes to the central log archive              |
| Detective         | AWS Config rules     | Detect S3 buckets that allow public read                 |
| Proactive         | CloudFormation hooks | Block a stack that would create a non-compliant resource |

A dashboard shows compliance across accounts, and violations can notify through SNS or trigger Lambda for remediation.

## People across accounts: IAM Identity Center and Directory Service

**IAM Identity Center** (the successor to AWS Single Sign-On) is the recommended way to give **workforce users** access to many accounts. One sign-in at the AWS access portal gives access to every assigned account and to SAML 2.0 business applications.

- **Identity source:** the built-in Identity Center directory, Active Directory, or an external identity provider (for example Okta or Microsoft Entra ID).
- **Permission sets:** a set of IAM policies (AWS managed, customer managed, inline, optionally a permissions boundary). Assign a permission set to a user or group for chosen accounts, and Identity Center creates and manages a matching IAM role in each account. Example: one `DatabaseAdmin` permission set, assigned to the database team, for the three accounts that run their databases.
- **Sessions** last 1 hour by default per permission set, up to 12 hours.
- **ABAC:** user attributes from the identity source (cost centre, team, location) can be used as tags in policies, so changing a user's attribute changes their access without new policies.

**AWS Directory Service** brings Microsoft Active Directory to AWS:

| Option                   | What it is                                                        | Good for                                                                                      |
| ------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| AWS Managed Microsoft AD | A real Microsoft AD run by AWS; users live in AWS                 | AD-aware apps and RDS for SQL Server in AWS; can **trust** an on-premises AD (both ways)      |
| AD Connector             | A proxy that forwards sign-ins to your AD; users stay on premises | Using the existing on-premises AD for AWS sign-in, with MFA through RADIUS; no directory sync |
| Simple AD                | A small AD-compatible directory (Samba 4); users live in AWS      | Low cost and basic AD features; **no** trust with another AD and no MFA                       |

To use an on-premises AD with Identity Center, either connect it through **AD Connector** or create **AWS Managed Microsoft AD** with a two-way trust to it. AWS Managed Microsoft AD as the source works out of the box.

## App users: Amazon Cognito

IAM is for people and workloads that operate the AWS account. **Amazon Cognito** is for the users of _your_ web or mobile app: potentially millions of them, signing in from outside AWS.

|               | Cognito user pools                                                                                                     | Cognito identity pools                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Purpose       | Sign-up and sign-in for app users                                                                                      | Temporary AWS credentials for app users                                                               |
| Gives the app | Tokens (JWTs) after a sign-in                                                                                          | AWS credentials from an IAM role                                                                      |
| Features      | Username/email + password, password reset, email and phone verification, MFA, sign-in through Google, Facebook or SAML | Authenticated and guest (unauthenticated) roles; identities from user pools, social or SAML providers |
| Works with    | API Gateway and ALB validate the tokens before passing the request on                                                  | The app calls AWS services such as S3 or DynamoDB directly                                            |

With identity pools, IAM policy variables (the user's Cognito identity ID) give **per-user access**: a user can read only DynamoDB items whose partition key is their own ID, or only their own prefix in an S3 bucket.

## Auditing access

**AWS CloudTrail** records API calls made in the account, from the console, CLI, SDKs and AWS services. It answers "who did what, when, from where".

- **Event history** shows management events for **90 days**, with no setup. For longer, create a **trail** that delivers to S3 (query with Athena) and optionally CloudWatch Logs. A trail can cover all Regions or one, and an **organization trail** in the management account covers every account.
- **Management events** (creating a user, attaching a policy, changing a subnet) are logged by default. **Data events** (S3 object reads and writes, Lambda invocations) are high-volume and must be turned on.
- **CloudTrail Insights** learns the account's normal API call and error rates and flags unusual activity, such as a sudden burst of IAM actions.
- CloudTrail events reach **EventBridge**, so a rule can alert through SNS when, for example, someone assumes a sensitive role or opens a security group.

| Question                                                  | Service                       |
| --------------------------------------------------------- | ----------------------------- |
| Who changed or deleted this resource?                     | CloudTrail                    |
| How was it configured last week, and is it compliant now? | AWS Config                    |
| Is it healthy and performing (metrics, logs, alarms)?     | CloudWatch                    |
| Which users have old access keys or no MFA?               | IAM credential report         |
| Which permissions has this role never used?               | IAM last accessed information |

## If the exam says… → think…

| If the exam says…                                                                | Think…                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| An application on EC2 or Lambda needs to call AWS APIs                           | An IAM role (instance profile, execution role), no stored access keys         |
| Give the same permissions to a whole team                                        | An IAM group with a policy, or a permission set in IAM Identity Center        |
| Restrict what a whole account or OU can do, even its admins                      | An SCP                                                                        |
| Let team leads create roles without allowing privilege escalation                | A permissions boundary, required with the `iam:PermissionsBoundary` condition |
| A partner or vendor must access your account                                     | A cross-account role whose trust policy requires an external ID               |
| A principal must keep its own permissions while using another account's resource | A resource-based policy (bucket, queue, topic or key policy)                  |
| Allow every account in the organization, including future ones                   | `aws:PrincipalOrgID` in the resource policy                                   |
| One sign-in for employees across many accounts                                   | IAM Identity Center with permission sets                                      |
| Employees already exist in on-premises Active Directory                          | Identity Center with AD Connector, or AWS Managed Microsoft AD with a trust   |
| Set up a new multi-account environment with best-practice guardrails             | AWS Control Tower                                                             |
| Millions of mobile or web app users need accounts and sign-in                    | Cognito user pools                                                            |
| App users must upload directly to S3 or read their own DynamoDB items            | Cognito identity pools with IAM policy variables                              |
| Find who deleted a resource                                                      | CloudTrail                                                                    |
| Keep API activity for years and query it                                         | A CloudTrail trail to S3, queried with Athena                                 |
| Require MFA before a dangerous action                                            | `aws:MultiFactorAuthPresent` in a deny statement                              |

## Common traps

- **An SCP that allows something does not grant it.** Users still need an IAM policy that allows the action.
- **SCPs don't touch the management account.** Keep workloads out of it; an SCP can't protect them there.
- **SCPs do restrict a member account's root user**, but not service-linked roles.
- **An explicit deny always wins**, whatever allows it elsewhere (identity, resource, boundary or SCP).
- **Permissions boundaries and SCPs limit; they never add.** The result is the intersection, which can be empty.
- **Groups are not principals.** A bucket policy or trust policy can't name a group, and groups can't be nested.
- **Assuming a role replaces your permissions** for that session. Use a resource-based policy when the caller needs both accounts' resources at once.
- **Cross-account needs both sides.** A bucket policy that allows account A is not enough if the user in A has no IAM policy for it.
- **The external ID is not a password.** It stops the confused deputy problem; it does not authenticate anyone, and it comes from the third party.
- **Simple AD can't trust an on-premises AD** and has no MFA. For a trust, choose AWS Managed Microsoft AD.
- **Cognito user pools give tokens, identity pools give AWS credentials.** An app that only needs sign-in doesn't need an identity pool.
- **CloudTrail event history stops at 90 days.** Long-term retention needs a trail to S3.
- **S3 data events are not logged by default.** "Who read this object" needs data events turned on.

## Links

**AWS documentation**

- [Policy evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)
- [Permissions boundaries for IAM entities](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
- [Cross account resource access in IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies-cross-account-resource-access.html)
- [The confused deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html)
- [AssumeRole (AWS STS API)](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html)
- [Service control policies (SCPs)](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)
- [About controls in AWS Control Tower](https://docs.aws.amazon.com/controltower/latest/controlreference/controls.html)
- [Permission sets in IAM Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/permissionsetsconcept.html)
- [What is AWS Directory Service?](https://docs.aws.amazon.com/directoryservice/latest/admin-guide/what_is.html)
- [Amazon Cognito user pools](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools.html) and [identity pools](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-identity.html)
- [AWS CloudTrail concepts](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-concepts.html)

**Practice**

- [Practice tests](/practice/): in the **Practice** card, choose **Practice by: Task** and then **1.1** to drill only this task.

**Lab**

- A hands-on lab on role assumption with a permissions boundary is being built.
