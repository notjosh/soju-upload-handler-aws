import { Resource } from "sst";
import { Example } from "@soju-upload-handler-aws/core/example";

console.log(`${Example.hello()} Linked to ${Resource.MyBucket.name}.`);
