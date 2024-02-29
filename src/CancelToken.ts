export class CancelToken {
  private shouldCancel = false;

  cancel = () => {
    this.shouldCancel = true;
  };

  get isCancellationRequested() {
    return this.shouldCancel;
  }
}
