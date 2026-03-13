declare namespace Express {
  interface Request {
    auth?: {
      email?: string;
      sub?: string;
      name?: string;
    };
  }
}
