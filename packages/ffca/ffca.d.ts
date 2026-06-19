declare module "*.sol" {
  const entrypoint: import("./src/sol-parse").FFCASolidityEntrypoint;
  export default entrypoint;
}
