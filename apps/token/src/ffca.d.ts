declare module "*.sol" {
  const entrypoint: import("ffca").FFCASolidityEntrypoint;
  export default entrypoint;
}
