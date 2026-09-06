# Referenced by ARN only — the secret VALUE is never read into Terraform
# state. This is a data source (read existing), not a managed resource:
# Terraform must never create/own/rotate this secret's value.
data "aws_secretsmanager_secret" "youtube_api_key" {
  name = "yobi-analytics/youtube-api-key"
}
