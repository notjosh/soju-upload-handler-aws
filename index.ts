import crypto from "crypto";
import { Resource } from "sst";
import { Handler } from "aws-lambda";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const filenameWithRandomSuffix = (filename: string) => {
  const randomString = crypto.randomBytes(4).toString("hex");
  const ext = filename.split(".").pop();
  const name = ext != null ? filename.slice(0, -ext.length - 1) : filename;
  const obfuscated = `${name}-${randomString}`;
  const newFilename = ext != null ? obfuscated + "." + ext : obfuscated;
  return newFilename;
};

const uniqueFilenameForBucket = async (
  filename: string,
  bucketName: string,
  attemptsRemaining = 3,
): Promise<string> => {
  if (attemptsRemaining === 0) {
    throw new Error("Could not generate a unique filename");
  }

  const newFilename = filenameWithRandomSuffix(filename);

  const client = new S3Client();
  const command = new HeadObjectCommand({
    Bucket: bucketName,
    Key: newFilename,
  });

  try {
    await client.send(command);

    // file exists, try again
    return await uniqueFilenameForBucket(filename, bucketName, attemptsRemaining - 1);
  } catch {
    // file does not exist, return newFilename
    return newFilename;
  }
};

interface RequestEvent {
  version: "2.0";
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  requestContext: {
    accountId: string;
    apiId: string;
    domainName: string;
    domainPrefix: string;
    http: {
      method: string;
      path: string;
      protocol: string;
      sourceIp: string;
      userAgent: string;
    };
    requestId: string;
    routeKey: string;
    stage: string;
    time: string;
    timeEpoch: number;
  };
  body: string | undefined;
  isBase64Encoded: boolean;
}

export const upload: Handler<RequestEvent> = async (event) => {
  // request will come in with the following:
  //
  // method: POST
  // header: User-Agent: Soju
  // header?: Content-Disposition: attachment; filename="example.jpg"
  // header?: Content-Type: image/jpeg
  // header: Soju-Username: some-username
  // body: binary image data
  //
  // The function should:
  // 1. Validate the request (check User-Agent, Content-Type, Soju-Username)
  // 2. Extract the image data from the body
  // 3. Generate a unique filename (e.g., using UUID)
  // 4. Upload the image to the linked S3 bucket with the generated filename
  // 5. Return a response with the URL of the uploaded image in the Location header (or an error message in the body)

  try {
    const username = event.headers["soju-username"];
    const file = event.body
      ? {
          // if no filename provided, make a generic name based on the content-type
          filename: event.headers["content-disposition"]
            ? event.headers["content-disposition"].split('filename="')[1].split('"')[0]
            : "unknown",
          // TODO: detect content-type from binary data if not provided
          contentType: event.headers["content-type"] ?? "application/octet-stream",
          content: Buffer.from(
            event.isBase64Encoded ? event.body : Buffer.from(event.body, "utf-8").toString("base64"),
            "base64",
          ),
          encoding: "utf-8",
        }
      : undefined;

    // validate values
    if (username == null) {
      return {
        statusCode: 400,
        body: "ERR: Missing `username`",
      };
    }

    if (file == null) {
      return {
        statusCode: 400,
        body: "ERR: Missing `file`",
      };
    }

    // check token against known tokens
    const allowedUsernames = (process.env.USERNAME_ALLOW_LIST ?? "").split(",");
    if (!allowedUsernames.includes(username)) {
      return {
        statusCode: 403,
        body: "ERR: Invalid username",
      };
    }

    // validate file is an image
    const isImage = file.contentType.startsWith("image/");
    if (!isImage) {
      return {
        statusCode: 400,
        body: "ERR: Invalid file type",
      };
    }

    // create an obfuscated filename, and ensure it is unique
    const newFilename = await uniqueFilenameForBucket(file.filename, Resource.ExistingStorage.name);

    // upload file to s3, and make public
    console.log(`Uploading ${file.filename} to ${Resource.ExistingStorage.name} as ${newFilename}...`);

    const client = new S3Client();
    const command = new PutObjectCommand({
      Bucket: Resource.ExistingStorage.name,
      Key: newFilename,
      Body: file.content,
      ContentType: file.contentType,
      ContentEncoding: file.encoding,
      ACL: "public-read",
    });

    await client.send(command);

    // return the url to the file
    const domain =
      process.env.CDN_DOMAIN && process.env.CDN_DOMAIN !== ""
        ? process.env.CDN_DOMAIN
        : `${Resource.ExistingStorage.name}.s3.amazonaws.com`;
    const url = `https://${domain}/${newFilename}`;
    return {
      statusCode: 200,
      body: `SUCCESS: ${url}`,
      headers: {
        location: url,
      },
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: `ERR: Application error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
