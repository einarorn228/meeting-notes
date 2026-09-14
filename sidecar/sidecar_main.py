"""PyInstaller entry point for the speech-to-text sidecar.

PyInstaller runs the analysed script as ``__main__`` with no package context. Pointing it straight at
``fundarritari_stt/__main__.py`` therefore makes that module's relative imports fail with
``ImportError: attempted relative import with no known parent package`` the instant the binary starts,
which reaches the app only as "sidecar exited". This wrapper imports the package the normal way instead.
"""

import sys

from fundarritari_stt.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
