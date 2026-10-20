# modules/tags

Builds the tag map every lab and bootstrap stack must carry: `project = "saa-c03-field-guide"` and `lab = <lab id>`, plus optional extra tags. The module has no resources, data sources or providers, so it needs no credentials and costs nothing.

## Inputs

| Name    | Type          | Default | Description                                                                                                                    |
| ------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `lab`   | `string`      | none    | Lab id. Format below.                                                                                                          |
| `extra` | `map(string)` | `{}`    | Extra tags merged in. Keys `project` and `lab` (any case) and keys starting with `aws:` (any case) are rejected by validation. |

### Lab id format

- `NN-kebab-name`: two digits, then one or more lowercase alphanumeric segments separated by single dashes (`00-site-hosting`, `12-vpc-peering-demo`).
- `bootstrap-management` or `bootstrap-workload` for the bootstrap stacks.

Anything else (`00`, `0-x`, `00_site`, `00-Site`, `00-site-`, `00--site`, `bootstrap`) fails validation.

## Outputs

| Name   | Description                                                                      |
| ------ | -------------------------------------------------------------------------------- |
| `tags` | `merge(var.extra, { project = "saa-c03-field-guide", lab = var.lab })` as a map. |

## Usage

With the AWS provider's `default_tags` (every taggable resource in the stack gets the tags):

```hcl
module "tags" {
  source = "../../modules/tags"

  lab = "00-site-hosting"
}

provider "aws" {
  region = "eu-west-1"

  default_tags {
    tags = module.tags.tags
  }
}
```

With an explicit `tags` argument (for resources outside `default_tags`, such as launch template tag specifications or Auto Scaling group tags):

```hcl
resource "aws_s3_bucket" "site" {
  bucket = "example"
  tags   = module.tags.tags
}
```

With extra tags:

```hcl
module "tags" {
  source = "../../modules/tags"

  lab   = "00-site-hosting"
  extra = { owner = "david" }
}
```

## Tests

```bash
terraform -chdir=modules/tags init -backend=false
terraform -chdir=modules/tags test
```
