import fsPromises from 'fs/promises';
import debounce from 'debounce';

// TODO: move into the job?
class PackageWatcher {
  #job;

  #meteorPackage;

  // TODO: abortController is experimental - how the hell are you supposed to abort without experimental?
  #abortController;

  triggerRebuild = debounce(this.#rebuild, 100);

  constructor(job, meteorPackage) {
    this.#job = job;
    this.#meteorPackage = meteorPackage;
  }

  async #rebuild() {
    console.log('rebuilding', this.#meteorPackage.meteorName);
    // this.#abortController.abort();
    await this.#job.reconvert(this.#meteorPackage);
    console.log('rebuilt', this.#meteorPackage.meteorName);
    // this.watch();
  }

  async #watchFile(file) {
    try {
      const watcher = fsPromises.watch(file);
      for await (const event of watcher) {
        this.triggerRebuild();
      }
    }
    catch (err) {
      if (err.name === 'AbortError') {
        return;
      }
      throw err;
    }
  }

  watch() {
    if (this.#abortController) {
      this.#abortController.abort();
    }
    // this.#abortController = new AbortController();
    this.#meteorPackage.filesToWatch().map((fileToWatch) => this.#watchFile(fileToWatch));
  }
}

export default function watchPackages(job, { watchAll = false } = {}) {
  const packagesToWatch = watchAll ? job.getAll() : job.getAllLocal();
  packagesToWatch.forEach((meteorPackage) => {
    const watcher = new PackageWatcher(job, meteorPackage);
    watcher.watch();
  });
}
