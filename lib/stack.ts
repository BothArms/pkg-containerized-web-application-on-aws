import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

const HOSTED_ZONE_ID = "xxx";
const ZONE_NAME = "yyy.com";
const CONTAINER_PORT = 80;
const CONTAINER_HEALTHCHECK_PATH = "/foo/bar.html";

export class Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const route53Zone = this.importRoute53Zone();

    const vpc = this.createVpc();

    const wafWebAcl = this.createWafWebAcl();

    const bucket = this.createBucket();

    const { rdsSecurityGroup, rdsCluster } = this.createRdsCluster(vpc);

    const { cacheSecurityGroup, cacheCluster } = this.createCacheCluster(vpc);

    const ecsCluster = this.createEcsCluster(vpc);

    const certificate = this.createCertificate(route53Zone);

    const loadBalancedEcsService = this.createLoadBalancedEcsService(
      ecsCluster,
      rdsCluster,
      cacheCluster,
      rdsSecurityGroup,
      cacheSecurityGroup,
      certificate,
      bucket
    );

    const cloudfrontDistribution = this.createCloudfrontDistribution(
      route53Zone,
      certificate,
      loadBalancedEcsService,
      wafWebAcl
    );

    this.createRoute53Record(route53Zone, cloudfrontDistribution);
  }

  importRoute53Zone() {
    return route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: ZONE_NAME,
    });
  }

  createCertificate(route53Zone: route53.IHostedZone) {
    return new acm.Certificate(this, "Certificate", {
      domainName: route53Zone.zoneName,
      subjectAlternativeNames: [`*.${route53Zone.zoneName}`],
      validation: acm.CertificateValidation.fromDns(route53Zone),
    });
  }

  createVpc() {
    return new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });
  }

  createBucket() {
    return new s3.Bucket(this, "Bucket", {});
  }

  createEcsCluster(vpc: ec2.Vpc) {
    return new ecs.Cluster(this, "Cluster", {
      vpc,
    });
  }

  createLoadBalancedEcsService(
    ecsCluster: ecs.Cluster,
    rdsCluster: rds.DatabaseCluster,
    cacheCluster: elasticache.CfnCacheCluster,
    rdsSecurityGroup: ec2.SecurityGroup,
    cacheSecurityGroup: ec2.SecurityGroup,
    certificate: acm.Certificate,
    bucket: s3.Bucket
  ) {
    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      "Service",
      {
        cluster: ecsCluster,
        memoryLimitMiB: 1024,
        listenerPort: 443,
        taskImageOptions: {
          image: ecs.ContainerImage.fromAsset("./app"),
          containerPort: CONTAINER_PORT,
          environment: {
            DB_HOST: rdsCluster.clusterEndpoint.hostname,
            DB_USER: rdsCluster.secret
              ?.secretValueFromJson("username")
              .unsafeUnwrap()!,
            DB_PASSWORD: rdsCluster.secret
              ?.secretValueFromJson("password")
              .unsafeUnwrap()!,
            DB_NAME: "wordpress",
            CACHE_HOST: cacheCluster.attrRedisEndpointAddress,
          },
        },
        desiredCount: 2,
        certificate,
      }
    );
    service.targetGroup.configureHealthCheck({
      path: CONTAINER_HEALTHCHECK_PATH,
    });

    rdsSecurityGroup.addIngressRule(
      service.service.connections.securityGroups[0],
      ec2.Port.tcp(3306)
    );

    cacheSecurityGroup.addIngressRule(
      service.service.connections.securityGroups[0],
      ec2.Port.tcp(6379)
    );

    const scaling = service.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 3,
    });

    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 50,
    });

    scaling.scaleOnRequestCount("RequestScaling", {
      requestsPerTarget: 10000,
      targetGroup: service.targetGroup,
    });

    bucket.grantReadWrite(service.taskDefinition.taskRole);

    return service;
  }

  createRdsCluster(vpc: ec2.Vpc) {
    const rdsSecurityGroup = new ec2.SecurityGroup(this, "RdsSecurityGroup", {
      vpc,
      description: "Security group for RDS cluster",
    });
    const rdsCluster = new rds.DatabaseCluster(this, "Database", {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_07_1,
      }),
      writer: rds.ClusterInstance.provisioned("writer", {
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.M7G,
          ec2.InstanceSize.MEDIUM
        ),
      }),
      readers: [
        rds.ClusterInstance.provisioned("reader", {
          instanceType: ec2.InstanceType.of(
            ec2.InstanceClass.M7G,
            ec2.InstanceSize.MEDIUM
          ),
        }),
      ],
      defaultDatabaseName: "mysql",
      vpc,
      securityGroups: [rdsSecurityGroup],
    });
    return { rdsSecurityGroup, rdsCluster };
  }

  createCacheCluster(vpc: ec2.Vpc) {
    const cacheSecurityGroup = new ec2.SecurityGroup(
      this,
      "CacheSecurityGroup",
      {
        vpc,
        description: "Security group for Redis cache cluster",
      }
    );

    const cacheCluster = new elasticache.CfnCacheCluster(this, "CacheCluster", {
      engine: "redis",
      engineVersion: "7.0",
      numCacheNodes: 2,
      cacheNodeType: "cache.t6g.large",
      vpcSecurityGroupIds: [cacheSecurityGroup.securityGroupId],
    });
    return { cacheSecurityGroup, cacheCluster };
  }

  createWafWebAcl() {
    return new wafv2.CfnWebACL(this, "WebAcl", {
      defaultAction: {
        allow: {},
      },
      scope: "CLOUDFRONT",
      rules: [
        // AWS Managed Rules
        ...[
          "AWSManagedRulesCommonRuleSet",
          "AWSManagedRulesPHPRuleSet",
          "AWSManagedRulesWordPressRuleSet",
          "AWSManagedRulesSQLiRuleSet",
        ].map((name, index) => ({
          name,
          priority: index + 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name,
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${name}Metric`,
          },
        })),
      ],
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "WebAcl",
        sampledRequestsEnabled: true,
      },
    });
  }

  createCloudfrontDistribution(
    route53Zone: route53.IHostedZone,
    certificate: acm.Certificate,
    loadBalancedEcsService: ecsPatterns.ApplicationLoadBalancedFargateService,
    wafWebAcl: wafv2.CfnWebACL
  ) {
    const origin = new origins.LoadBalancerV2Origin(
      loadBalancedEcsService.loadBalancer,
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        httpPort: 80,
        httpsPort: 443,
      }
    );

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      },
      domainNames: [route53Zone.zoneName],
      certificate,
      webAclId: wafWebAcl.attrArn,
    });
    return distribution;
  }

  createRoute53Record(
    route53Zone: route53.IHostedZone,
    cloudfrontDistribution: cloudfront.Distribution
  ) {
    new route53.ARecord(this, "ARecord", {
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(cloudfrontDistribution)
      ),
      zone: route53Zone,
    });
  }
}
