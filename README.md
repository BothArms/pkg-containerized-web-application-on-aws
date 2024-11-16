# Containerized Web Application on AWS

This project provides an optimized infrastructure for running a containerized web application on AWS.

![AWS Architecture](/docs/architecture.svg)

Key features include:

- **High Performance with CloudFront CDN**: Content is distributed globally through AWS CloudFront's edge locations, ensuring fast delivery to users worldwide and reducing load on origin servers.

- **Secure Infrastructure with AWS WAF and NACLs**:
  The infrastructure utilizes ECS Fargate in private subnets for the ECS cluster, is protected by AWS WAF for advanced threat protection against common web exploits, implements multi-layer security with private VPC networking, security groups, and NACLs, and maintains regular security patches through managed container updates.

- **Scalable Architecture with Auto Scaling**: The infrastructure implements AWS Auto Scaling at multiple levels, with ECS Service Auto Scaling dynamically scaling the number of tasks/containers while the Application Load Balancer distributes traffic across the scaled resources, all working together to handle traffic spikes efficiently while maintaining high availability.


## Prerequisites

1. **AWS Account**: An active AWS account with appropriate permissions to create and manage resources.

2. **AWS CLI**: Install and configure the AWS CLI with your credentials.

   ```bash
   aws configure
   ```

3. **Node.js**: Install Node.js (version 18 or later) and npm.

   - Download from: https://nodejs.org/

4. **Domain Name**: A registered domain name and Route53 hosted zone.

   - Current configuration uses: kokorozashi-test.com

5. **Docker**: Install Docker to build container images locally.

   - Download from: https://www.docker.com/get-started

6. **Region**: This project is configured for us-east-1. If using a different region, the certificate implementation needs to be modified.

## Getting Started

1. Configure your domain settings in `lib/const.ts`:

   - `HOSTED_ZONE_ID`: The Route53 hosted zone ID.
   - `ZONE_NAME`: The domain name.

2. Configure your tags in `bin/app.ts`:

   - `Project`: The project name.
   - `Owner`: Your name.

3. Install dependencies

```bash
npm install
```

4. Deploy the infrastructure

```bash
npx cdk deploy --all
```
