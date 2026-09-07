provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "yobi-analytics"
      ManagedBy = "terraform"
    }
  }
}
