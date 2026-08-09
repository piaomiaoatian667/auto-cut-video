module.exports = {
  hooks: {
    afterAllResolved(lockfile) {
      for (const packageSnapshot of Object.values(lockfile.packages ?? {})) {
        if (packageSnapshot?.resolution?.integrity) {
          delete packageSnapshot.resolution.tarball;
        }
      }

      return lockfile;
    },
  },
};
