variable "aws_region" {
  description = "AWS region all Yobi Analytics resources live in"
  type        = string
  default     = "ap-northeast-1"
}

variable "aws_account_id" {
  description = "AWS account ID resources live in (used to build ARNs without a live data lookup)"
  type        = string
  default     = "189461315571"
}
