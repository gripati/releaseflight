import { FilesystemSecretProvider } from "./FilesystemSecretProvider";
import type { SecretProvider } from "./SecretProvider";

let _instance: SecretProvider | undefined;

export function createSecretProvider(): SecretProvider {
  if (_instance) return _instance;
  const kind = process.env.SECRET_PROVIDER ?? "filesystem";
  switch (kind) {
    case "filesystem":
      _instance = new FilesystemSecretProvider();
      break;
    case "aws-sm":
    case "vault":
      throw new Error(`SECRET_PROVIDER=${kind} not implemented yet (V2)`);
    default:
      throw new Error(`Unknown SECRET_PROVIDER: ${kind}`);
  }
  return _instance;
}
