// Keep production backend.ts and PhoneImport intact; replace only Decky's RPC transport.
export const callable =
  <Args extends unknown[], Result>(method: string) =>
  async (...args: Args): Promise<Result> => {
    const response = await fetch(`/fixture/rpc/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
