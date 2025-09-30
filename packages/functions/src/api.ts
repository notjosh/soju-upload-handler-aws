import { Resource } from "sst";
import { Handler } from "aws-lambda";
import { Example } from "@soju-upload-handler-aws/core/example";

// eslint-disable-next-line @typescript-eslint/require-await
export const handler: Handler = async (_event) => {
  return {
    statusCode: 200,
    body: `${Example.hello()} Linked to ${Resource.MyBucket.name}.`,
  };
};
