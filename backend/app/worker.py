"""Standalone worker entrypoint; use one process per shared data volume."""
from learnflow_core.worker_host import main

if __name__ == "__main__":
    main()
