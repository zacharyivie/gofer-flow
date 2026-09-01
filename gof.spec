# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules


block_cipher = None

datas = []
datas += collect_data_files("openpyxl")
datas += collect_data_files("tzdata")
datas += collect_data_files("vosk")
datas += [
    ("radish/contracts", "gofer/radish/assets/contracts"),
    ("radish/providers", "gofer/radish/assets/providers"),
    ("radish/schemas", "gofer/radish/assets/schemas"),
    ("radish/spec", "gofer/radish/assets/docs"),
    ("skills/gofer-flow-workflow-builder", "gofer/radish/assets/assistant-skill"),
]

hiddenimports = []
hiddenimports += collect_submodules("apscheduler")
hiddenimports += collect_submodules("gofer")
hiddenimports += collect_submodules("openpyxl")
hiddenimports += collect_submodules("pydantic")
hiddenimports += collect_submodules("pydantic_settings")
hiddenimports += collect_submodules("sqlalchemy")
hiddenimports += collect_submodules("typer")
hiddenimports += collect_submodules("vosk")

binaries = []
binaries += collect_dynamic_libs("vosk")

a = Analysis(
    ["packaging/pyinstaller/gof_entry.py"],
    pathex=["src"],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="gof",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
