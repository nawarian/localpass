package s3

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Client wraps the AWS S3 client for LocalPass operations.
type Client struct {
	s3Client *s3.Client
	bucket   string
	key      string
}

// Config holds S3 connection configuration.
type Config struct {
	Endpoint        string
	Region          string
	Bucket          string
	Key             string
	AccessKeyID     string
	SecretAccessKey string
}

// NewClient creates a new S3 client with the given configuration.
func NewClient(cfg Config) (*Client, error) {
	awsCfg, err := config.LoadDefaultConfig(context.TODO(),
		config.WithRegion(cfg.Region),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	// Create S3 client with optional custom endpoint and static credentials
	s3Opts := []func(*s3.Options){
		func(o *s3.Options) {
			if cfg.Endpoint != "" {
				o.BaseEndpoint = aws.String(cfg.Endpoint)
			}
			if cfg.AccessKeyID != "" && cfg.SecretAccessKey != "" {
				o.Credentials = aws.NewCredentialsCache(
					credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
				)
			}
		},
	}

	return &Client{
		s3Client: s3.NewFromConfig(awsCfg, s3Opts...),
		bucket:   cfg.Bucket,
		key:      cfg.Key,
	}, nil
}

// Upload uploads data to S3.
func (c *Client) Upload(ctx context.Context, data []byte) error {
	_, err := c.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(c.key),
		Body:   bytes.NewReader(data),
	})
	if err != nil {
		return fmt.Errorf("failed to upload to S3: %w", err)
	}
	return nil
}

// Download downloads data from S3.
func (c *Client) Download(ctx context.Context) ([]byte, error) {
	result, err := c.s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(c.key),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to download from S3: %w", err)
	}
	defer result.Body.Close()

	data, err := io.ReadAll(result.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read S3 response: %w", err)
	}

	return data, nil
}

// HeadObject retrieves metadata about the S3 object without downloading it.
func (c *Client) HeadObject(ctx context.Context) (*s3.HeadObjectOutput, error) {
	result, err := c.s3Client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(c.key),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to head S3 object: %w", err)
	}
	return result, nil
}

// LastModified returns the LastModified timestamp of the S3 object.
// Returns zero time and an error if the object doesn't exist.
func (c *Client) LastModified(ctx context.Context) (time.Time, error) {
	result, err := c.HeadObject(ctx)
	if err != nil {
		return time.Time{}, err
	}
	if result.LastModified == nil {
		return time.Time{}, nil
	}
	return *result.LastModified, nil
}

// ObjectExists checks if the S3 object exists.
func (c *Client) ObjectExists(ctx context.Context) (bool, error) {
	_, err := c.HeadObject(ctx)
	if err != nil {
		return false, nil // S3 returns an error for non-existent objects
	}
	return true, nil
}
