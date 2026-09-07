resource "aws_apigatewayv2_api" "http_api" {
  name          = "yobi-analytics-http-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "DELETE"]
    allow_headers = ["content-type", "x-admin-key", "x-client-secret"]
  }
}

resource "aws_apigatewayv2_integration" "api_lambda" {
  api_id                 = aws_apigatewayv2_api.http_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http_api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

locals {
  api_routes = [
    "GET /creators/{creatorId}/trending",
    "GET /remote-config",
    "POST /clients/{clientId}/credential",
    "POST /heartbeat",
    "GET /organizations/{organization}/trending",
    "POST /remote-config",
    "GET /admin/heartbeat-stats",
    "GET /heartbeat/{clientId}/status",
    "PUT /clients/{clientId}/notification-preference",
    "GET /videos/{videoId}/growth",
    "PUT /clients/{clientId}/push-subscription",
    "DELETE /clients/{clientId}/push-subscription",
  ]
}

resource "aws_apigatewayv2_route" "routes" {
  for_each = toset(local.api_routes)

  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_lambda_permission" "apigw_invoke_api" {
  statement_id  = "apigateway-invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http_api.execution_arn}/*/*"
}
