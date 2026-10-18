/** Preview programs never inherit platform database/auth/model credentials. */
export function frontendRuntimeEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
  for (const [key, value] of Object.entries(inherited)) {
    if (
      /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|SYSTEMDRIVE|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY)$/i.test(
        key,
      )
    )
      env[key] = value;
  }
  return env;
}
