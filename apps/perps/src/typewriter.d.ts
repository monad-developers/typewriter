declare module "*.sol" {
  const entrypoint: import("typewriter").TypewriterSolidityEntrypoint;
  export default entrypoint;
}
