import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Handler } from "aws-lambda";
import crypto from "crypto";
import { fileTypeFromBuffer } from "file-type";
import { Resource } from "sst";

// from Soju: https://codeberg.org/emersion/soju/src/branch/master/fileupload/fileupload.go
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/webm",
  "image/apng",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "video/mp4",
  "video/ogg",
  "video/webm",
]);

// from Soju: https://codeberg.org/emersion/soju/src/branch/master/fileupload/fileupload.go
const MAX_FILE_SIZE = 50 * 1024 * 1024;

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
  // the function should:
  // 1. validate the request (check User-Agent, Content-Type, Soju-Username)
  // 2. extract the image data from the body
  // 3. generate a unique filename
  // 4. upload the image to the linked S3 bucket with the generated filename
  // 5. return a response with the URL of the uploaded image in the Location header (or an error message in the body)

  try {
    const { body } = event;

    if (body == null) {
      return {
        statusCode: 400,
        body: "ERR: Missing body",
      };
    }

    const buffer = Buffer.from(event.isBase64Encoded ? body : Buffer.from(body, "utf-8").toString("base64"), "base64");

    if (buffer.byteLength > MAX_FILE_SIZE) {
      return { statusCode: 413, body: "ERR: File too large" };
    }

    const file = await (async () => {
      let contentType = event.headers["content-type"];
      let extension = contentType?.split("/")[1]?.split("+")[0] ?? "bin";

      if (
        contentType == null ||
        contentType === "application/octet-stream" ||
        contentType === "application/x-www-form-urlencoded"
      ) {
        const detectedType = await fileTypeFromBuffer(buffer);
        contentType = detectedType?.mime ?? "application/octet-stream";
        extension = detectedType?.ext ?? "bin";
      }

      // Generate filename if not provided
      const filename = event.headers["content-disposition"]
        ? event.headers["content-disposition"].split('filename="')[1].split('"')[0]
        : `upload-${Date.now().toString()}.${extension}`;

      return {
        filename,
        contentType,
        content: buffer,
        encoding: "utf-8",
      };
    })();

    const username = event.headers["soju-username"];

    // validate values
    if (username == null) {
      return {
        statusCode: 400,
        body: "ERR: Missing `username`",
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
    if (!ALLOWED_MIME_TYPES.has(file.contentType)) {
      return {
        statusCode: 400,
        body: `ERR: Content type ${file.contentType} is not allowed`,
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
      statusCode: 201,
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
