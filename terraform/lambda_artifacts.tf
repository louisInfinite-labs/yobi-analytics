# Dedicated artifact bucket for Lambda deployment ZIPs (72.5 MB compressed
# package, over Lambda's 50 MB direct-upload limit -- needs S3-based
# `aws lambda update-function-code --s3-bucket/--s3-key`, not --zip-file).
# Deliberately separate from aws_s3_bucket.history (history.tf) -- that
# bucket is Parquet history *data*, this one is deployment *artifacts*;
# mixing the two would tie their lifecycle/access-pattern/retention
# decisions together for no reason.
#
# Terraform manages only the bucket itself. The ZIP objects inside it are
# uploaded and referenced entirely outside Terraform (the existing manual
# `aws s3 cp` + `aws lambda update-function-code --s3-bucket/--s3-key`
# flow) -- same reasoning as lambda.tf's own placeholder-zip approach: this
# project's code deployment stays decoupled from `terraform apply`.
resource "aws_s3_bucket" "lambda_artifacts" {
  bucket        = "yobi-analytics-lambda-artifacts-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "lambda_artifacts" {
  bucket = aws_s3_bucket.lambda_artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "lambda_artifacts" {
  bucket = aws_s3_bucket.lambda_artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "lambda_artifacts" {
  bucket                  = aws_s3_bucket.lambda_artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
