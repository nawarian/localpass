/**
 * Configuration model for LocalPass – port of cli/internal/config/config.go
 */

export interface Config {
  s3_endpoint: string;
  s3_region: string;
  s3_bucket: string;
  s3_key: string;
  aws_access_key_id: string;
  aws_secret_access_key: string;
  auto_sync: boolean;
}

export function defaultConfig(): Config {
  return {
    s3_endpoint: "",
    s3_region: "",
    s3_bucket: "",
    s3_key: "",
    aws_access_key_id: "",
    aws_secret_access_key: "",
    auto_sync: false,
  };
}
