export class EnkryptifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnkryptifyError";
  }
}
