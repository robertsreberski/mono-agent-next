export async function createResponder(env, cwd, configPath) {
  const marker = env.AUD062_RESPONDER_MARKER;
  env.AUD062_RESPONDER_MARKER = "mutated inside factory";
  return {
    async respond(request) {
      return {
        text: JSON.stringify({ marker, cwd, configPath, prompt: request.text }),
      };
    },
  };
}
