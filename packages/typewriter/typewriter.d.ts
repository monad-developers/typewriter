declare module "*.sol" {
  const entrypoint: import("typewriter").FFCASolidityEntrypoint;
  export default entrypoint;
}
