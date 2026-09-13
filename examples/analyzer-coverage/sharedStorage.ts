import { ListObjectsV2Command, GetObjectCommand as ReadObject } from "@aws-sdk/client-s3";
export async function load() {
  await client.send(new ListObjectsV2Command({ Bucket: process.env.BUCKET }));
  return client.send(new ReadObject({ Bucket: process.env.BUCKET, Key: "report.json" }));
}
