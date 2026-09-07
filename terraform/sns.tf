resource "aws_sns_topic" "emergency_stop" {
  name = "yobi-analytics-emergency-stop-topic"
  # AWS-managed key: SNS/KMS grant sns.amazonaws.com the permissions it needs
  # automatically, so no extra key policy or publisher IAM grant is required
  # (unlike a customer-managed key, which would need both configured).
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "emergency_stop_lambda" {
  topic_arn = aws_sns_topic.emergency_stop.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.emergency_stop.arn
  # Without this, Terraform can create the subscription and the permission
  # concurrently; an SNS publish landing in that window would find no
  # invoke permission yet and fail.
  depends_on = [aws_lambda_permission.sns_invoke_emergency_stop]
}

resource "aws_lambda_permission" "sns_invoke_emergency_stop" {
  statement_id  = "lambda-5a647a1f-3145-4eca-9538-380b4079a989"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.emergency_stop.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.emergency_stop.arn
}
