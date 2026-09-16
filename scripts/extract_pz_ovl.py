"""Extract a Planet Zoo animal OVL into .ms2/.manis/.png on macOS.

Same job as cobra-tools' `ovl_tool_cmd.py extract`, plus the two macOS shims
from pz_mac_shims.py (ooz for Oodle archives, texture2ddecoder for DDS→PNG —
see that file for why). Run with any Python that has cobra-tools' deps
(numpy<2, imageio, pillow, bitarray) plus texture2ddecoder; the bpy venv from
the bobcat workflow works:

  /tmp/bpyenv44/bin/python scripts/extract_pz_ovl.py <animal.ovl> <out_dir>

One-time setup of the ooz dylib:
  git clone https://github.com/powzix/ooz /tmp/ooz
  # portable stdafx.h + extern-C wrapper, then:
  clang++ -O2 -std=c++14 -fPIC -shared -o /tmp/ooz/libooz.dylib \
      /tmp/ooz/kraken_lib.cpp /tmp/ooz/bitknit.cpp /tmp/ooz/lzna.cpp /tmp/ooz/ooz_c_api.cpp
"""
import os
import sys

COBRA_DIR = "/tmp/cobra-tools"
sys.path.insert(0, COBRA_DIR)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# cobra-tools logs at a custom SUCCESS level; logging_setup registers it.
from utils.logs import logging_setup  # noqa: E402
logging_setup("extract_pz_ovl")

import pz_mac_shims  # noqa: E402
pz_mac_shims.install()

from generated.formats.ovl import OvlFile  # noqa: E402
from modules.formats.shared import DummyReporter  # noqa: E402


def main():
    ovl_path, out_dir = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    os.makedirs(out_dir, exist_ok=True)

    ovl = OvlFile()
    ovl.reporter = DummyReporter()
    ovl.load_hash_table()
    ovl.load(ovl_path, commands={"game": "Planet Zoo"})
    out_paths = ovl.extract(out_dir)
    print(f"extracted {len(out_paths) if out_paths else '?'} files → {out_dir}")


if __name__ == "__main__":
    main()
