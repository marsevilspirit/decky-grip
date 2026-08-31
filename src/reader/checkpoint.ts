export class ReaderCheckpoint {
  private safe = false;
  private scrollIntended = false;

  get canPersist(): boolean {
    return this.safe;
  }

  block(): void {
    this.safe = false;
    this.scrollIntended = false;
  }

  settle(): void {
    this.safe = true;
    this.scrollIntended = false;
  }

  intendScroll(): void {
    this.scrollIntended = true;
  }

  didScroll(): void {
    if (this.scrollIntended) {
      this.safe = true;
    }
    this.scrollIntended = false;
  }
}
