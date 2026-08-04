import { describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { ensureBucket } from "./ensureBucket.js";

function fakeClient(send: (command: unknown) => Promise<unknown>): S3Client {
  return { send } as unknown as S3Client;
}

describe("ensureBucket", () => {
  it("returns already-exists without creating when the bucket is found", async () => {
    const send = vi.fn().mockResolvedValueOnce({});
    const result = await ensureBucket(fakeClient(send), "railway-raw");

    expect(result).toBe("already-exists");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("creates the bucket when a NotFound error is returned by HeadBucket", async () => {
    const notFound = Object.assign(new Error("not found"), { name: "NotFound" });
    const send = vi.fn().mockRejectedValueOnce(notFound).mockResolvedValueOnce({});

    const result = await ensureBucket(fakeClient(send), "railway-raw");

    expect(result).toBe("created");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rethrows errors that are not a not-found response", async () => {
    const forbidden = Object.assign(new Error("forbidden"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    const send = vi.fn().mockRejectedValueOnce(forbidden);

    await expect(ensureBucket(fakeClient(send), "railway-raw")).rejects.toThrow("forbidden");
  });
});
