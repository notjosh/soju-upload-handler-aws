/* eslint-disable @typescript-eslint/require-await */

// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "soju-upload-handler-aws",
      removal: input.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input.stage),
      home: "aws",
      providers: {
        aws: {
          region: "eu-central-1",
        },
      },
    };
  },
  async run() {
    const bucketName = $app.stage === "production" ? "shottr-handler-prod" : "tmp-soju-upload-handler-aws-dev";

    const bucket = aws.s3.BucketV2.get("ExistingBucket", bucketName);
    const storage = new sst.Linkable("ExistingStorage", {
      properties: {
        name: bucket.bucket,
      },
    });

    const api = new sst.aws.ApiGatewayV2("Api", {
      link: [storage],
      domain:
        $app.stage === "production" && process.env.API_DOMAIN
          ? {
              name: process.env.API_DOMAIN,
            }
          : undefined,
    });

    api.route("POST /upload", {
      handler: "index.upload",
      environment: {
        BUCKET_NAME: storage.name,
        ...(process.env.USERNAME_ALLOW_LIST ? { USERNAME_ALLOW_LIST: process.env.USERNAME_ALLOW_LIST } : {}),
        ...($app.stage === "production" && process.env.CDN_DOMAIN ? { CDN_DOMAIN: process.env.CDN_DOMAIN } : {}),
      },
      permissions: [
        {
          actions: ["s3:PutObject", "s3:PutObjectAcl", "s3:GetObject"],
          resources: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
        },
      ],
    });
  },
});
