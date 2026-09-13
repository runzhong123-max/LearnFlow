"""Render the DOCX through the supplied bundled renderer with readable CJK fonts.

No user application, global font installation, or managed runtime modification.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from xml.sax.saxutils import escape

HERE=Path(__file__).resolve().parent
p=argparse.ArgumentParser()
p.add_argument('--renderer',type=Path,required=True)
p.add_argument('--output-dir',type=Path,required=True)
a=p.parse_args()
runtime=Path(sys.executable).resolve().parent.parent.parent
bundled_fonts=runtime/'native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fonts/truetype'
assert bundled_fonts.is_dir(), 'Use the workspace bundled Python runtime on macOS.'
assert a.renderer.name=='render_docx.py' and a.renderer.is_file()
with tempfile.TemporaryDirectory(prefix='learnflow-paper-fonts-') as tmp:
    cache=Path(tmp)/'cache';cache.mkdir()
    dirs=[Path('/System/Library/Fonts/Supplemental'),Path('/System/Library/Fonts'),bundled_fonts]
    assert all(d.is_dir() for d in dirs)
    config=Path(tmp)/'fonts.conf'
    config.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>'+
        ''.join(f'<dir>{escape(str(d))}</dir>' for d in dirs)+f'<cachedir>{escape(str(cache))}</cachedir></fontconfig>')
    env=os.environ.copy();env['FONTCONFIG_FILE']=str(config)
    subprocess.run([sys.executable,str(a.renderer),str(HERE/'five_kernel_learner_memory_zh.docx'),
                    '--output_dir',str(a.output_dir),'--emit_pdf'],env=env,check=True)
