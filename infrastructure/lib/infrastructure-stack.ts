import { IKey } from "aws-cdk-lib/aws-kms";
import { App, Aws, SecretValue, Stack, StackProps } from "aws-cdk-lib";
import { Artifact, Pipeline } from "aws-cdk-lib/aws-codepipeline";
import { AccountPrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CodeBuildAction, GitHubSourceAction, S3DeployAction } from "aws-cdk-lib/aws-codepipeline-actions";
import { BuildSpec, GitHubSourceCredentials, PipelineProject } from "aws-cdk-lib/aws-codebuild";
import { Distribution, GeoRestriction, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { CacheControl } from "aws-cdk-lib/aws-s3-deployment";
import { BlockPublicAccess, Bucket, BucketAccessControl } from "aws-cdk-lib/aws-s3";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";

export class BuildStack extends Stack {
  public readonly artifactBucketEncryptionKey? : IKey

  constructor(parent: App, name: string, props: StackProps) {
    super(parent, name, props);
    const { env } = props;
    
    const hostedZone = new HostedZone(this, "HostedZone", {
      zoneName: 'elchung.com'
    })
    const cert = new Certificate(this, 'elchungCert', {
      domainName: 'elchung.com',
      subjectAlternativeNames: ['*.elchung.com'],
      certificateName: 'elchung-cert',
      validation: CertificateValidation.fromDns(hostedZone),

    });
    
    
    const pipeline = new Pipeline(this, 'Pipeline', {
      pipelineName: "elchung-dot-com-build-pipeline",
      crossAccountKeys: false,
    });
    this.artifactBucketEncryptionKey = pipeline.artifactBucket.encryptionKey;
    if (this.artifactBucketEncryptionKey) {
      // Other stacks may need access to the artifact bucket. This will grant any IAM
      // role in the account access to the key so they can access the bucket.
      // Roles will still need policy statements on them to access the key.
      this.artifactBucketEncryptionKey.grant(new AccountPrincipal(Aws.ACCOUNT_ID), 'kms:*');
    }

    pipeline.addToRolePolicy(new PolicyStatement({
      actions: ["iam:PassRole"],
      resources: ["*"]
    }));

    // Allow the pipeline to execute CFN changes
    pipeline.addToRolePolicy(new PolicyStatement({
      actions: [
        "cloudFormation:Describe*",
        "cloudFormation:Get*",
        "cloudFormation:List*",
        "cloudFormation:Validate*",
        "cloudformation:CreateChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet"
      ],
      resources: ["*"]
    }));

    const oauthToken = SecretValue.secretsManager('elchung-oauth')
    new GitHubSourceCredentials(this, 'CodeBuildGitHubCreds', {
      // ssm secure token was manually entered via console
      accessToken: oauthToken,
    });


    const bucket = new Bucket(this, `build_output_bucket_${env!.region}`, {
      publicReadAccess: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ACLS,
      bucketName: `build-output-${env!.region}-${Aws.ACCOUNT_ID}`,
      enforceSSL: true,
    });
    const loggingBucket = new Bucket(this, 'access_logging_bucket', {
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      bucketName: `access-logging-${env!.region}-${Aws.ACCOUNT_ID}`,
      accessControl: BucketAccessControl.LOG_DELIVERY_WRITE
    })
    new Distribution(this, `elchung`, {
      enabled: true,
      enableLogging: true,
      logBucket: loggingBucket,
      certificate: cert,
      geoRestriction: GeoRestriction.allowlist('US', 'CA'),
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS
      },
      errorResponses:[
        {
          httpStatus: 403,
          responsePagePath: '/index.html',
          responseHttpStatus: 200,
        }
      ],
      domainNames: ['elchung.com', 'www.elchung.com'],
      defaultRootObject: 'index.html',
    });



    const project = new PipelineProject(this, 'elchungProj', {
      projectName: 'elchung-com-pipeline-project',
      buildSpec: BuildSpec.fromObject({
        version: '0.1',
        phases: {
          install: {
            commands: ['npm install'],
          },
          build: {
            commands: [
              'npm run lint',
              'npm run test',
              'npm run deploy',
            ]
          },
        }
      })
    });

    project.addToRolePolicy(new PolicyStatement({
      actions: ["s3:GetObject"],
      resources: ["*"]
    }));
    project.addToRolePolicy(new PolicyStatement({
      actions: ["s3:PutObject"],
      resources: ["*"]
    }));

    const githubOutput = new Artifact("source");
    
    const buildOutput = new Artifact("build");
    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new GitHubSourceAction({
          owner: 'elchung',
          oauthToken: oauthToken,
          actionName: 'source',
          repo: 'elchung.com',
          output: githubOutput,
          branch: 'main',
        }),
      ]
    });

    pipeline.addStage({
      stageName: "Build",
      actions: [
        new CodeBuildAction({
          actionName: "Build",
          input: githubOutput,
          project: project,
          outputs: [buildOutput],
        })
      ]
    });

    pipeline.addStage({
      stageName: `update-${env!.region}`,
      actions: [
        new S3DeployAction({
          input: buildOutput,
          bucket,
          extract: true,
          cacheControl: [CacheControl.noCache()],
          actionName: `deploy-website`,
          accessControl: BucketAccessControl.PUBLIC_READ,
          runOrder: 1,
        })
      ],
    });
  }
}
