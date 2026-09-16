"""macOS shims for cobra-tools, used by extract_pz_ovl.py / extract_pz_animal.py.

cobra-tools assumes Windows for two pieces of the OVL pipeline:

  1. Oodle decompression — ctypes-loads oo2core_8_win64.dll. Newer Planet Zoo
     packs (e.g. the 2026 goat) compress their OVS archives with Oodle Kraken,
     so without this nothing extracts. We stand in the open-source `ooz`
     decoder (github.com/powzix/ooz), built as /tmp/ooz/libooz.dylib with a
     tiny extern-C wrapper `Ooz_Decompress(src, src_len, dst, dst_len)`.

  2. DDS → PNG via texconv.exe. We decode the BC-compressed DDS payload with
     the `texture2ddecoder` wheel and write the PNG with Pillow instead.

Call `install()` AFTER cobra-tools paths are on sys.path but BEFORE OvlFile
is used. Patching must hit the names the call sites actually read:
  - generated.formats.ovl.oodle_compressor   (module global, checked truthy)
  - modules.formats.utils.dds_conversion.dds_to_png  (called via module attr)
"""
import ctypes
import os
import struct

OOZ_DYLIB = "/tmp/ooz/libooz.dylib"

# ooz writes a little past the end of the destination buffer (its CLI
# allocates dst_len + 64 the same way).
OOZ_SAFE_SPACE = 64


class OozDecompressor:
    """Duck-type of cobra-tools' OodleDecompressor, decompress-only."""

    def __init__(self, library_path=OOZ_DYLIB):
        if not os.path.exists(library_path):
            raise FileNotFoundError(
                f"{library_path} missing — build it from github.com/powzix/ooz "
                f"(see scripts/extract_pz_ovl.py header for the clang++ line)")
        lib = ctypes.cdll.LoadLibrary(library_path)
        lib.Ooz_Decompress.restype = ctypes.c_int
        lib.Ooz_Decompress.argtypes = [
            ctypes.c_char_p, ctypes.c_size_t,
            ctypes.c_char_p, ctypes.c_size_t,
        ]
        self._lib = lib

    def decompress(self, payload, size, output_size):
        out = ctypes.create_string_buffer(output_size + OOZ_SAFE_SPACE)
        ret = self._lib.Ooz_Decompress(payload, size, out, output_size)
        if ret != output_size:
            raise ValueError(f"ooz decompression failed: ret={ret}, expected {output_size}")
        return out.raw[:output_size]

    def compress(self, payload, codec_name="Kraken", level=6):
        raise NotImplementedError("ooz is decompress-only; injecting OVLs needs real Oodle")


# DXGI formats we expect from PZ .tex files → texture2ddecoder decoder name.
# Values from the DXGI_FORMAT enum.
_DXGI_BC = {
    71: "bc1", 72: "bc1",          # BC1_UNORM, BC1_UNORM_SRGB
    77: "bc3", 78: "bc3",          # BC3_UNORM, BC3_UNORM_SRGB
    80: "bc4",                      # BC4_UNORM
    83: "bc5",                      # BC5_UNORM
    95: "bc6", 96: "bc6",          # BC6H_UF16, BC6H_SF16
    98: "bc7", 99: "bc7",          # BC7_UNORM, BC7_UNORM_SRGB
}
_DXGI_RAW_RGBA = (28, 29)           # R8G8B8A8_UNORM(_SRGB)
_DXGI_RAW_BGRA = (87, 91)           # B8G8R8A8_UNORM(_SRGB)


def dds_to_png(dds_file_path, codec=None):
    """Drop-in replacement for modules.formats.utils.dds_conversion.dds_to_png.

    Only converts the top mip of a DX10-header DDS (which is what cobra-tools
    writes during extraction). Returns the written PNG path.
    """
    import texture2ddecoder
    from PIL import Image

    with open(dds_file_path, "rb") as f:
        data = f.read()
    if data[:4] != b"DDS ":
        raise ValueError(f"not a DDS file: {dds_file_path}")
    height, width = struct.unpack_from("<II", data, 12)
    fourcc = data[84:88]
    if fourcc == b"DX10":
        dxgi = struct.unpack_from("<I", data, 128)[0]
        payload = data[148:]
    else:
        raise ValueError(f"only DX10 DDS supported, got fourcc {fourcc!r}")

    if dxgi in _DXGI_RAW_RGBA:
        img = Image.frombuffer("RGBA", (width, height), payload[:width * height * 4],
                               "raw", "RGBA", 0, 1)
    elif dxgi in _DXGI_RAW_BGRA:
        img = Image.frombuffer("RGBA", (width, height), payload[:width * height * 4],
                               "raw", "BGRA", 0, 1)
    elif dxgi in _DXGI_BC:
        decode = getattr(texture2ddecoder, f"decode_{_DXGI_BC[dxgi]}")
        bgra = decode(payload, width, height)
        img = Image.frombuffer("RGBA", (width, height), bgra, "raw", "BGRA", 0, 1)
    else:
        raise ValueError(f"unhandled DXGI format {dxgi} in {dds_file_path}")

    png_path = os.path.splitext(dds_file_path)[0] + ".png"
    img.save(png_path)
    return png_path


def install():
    import generated.formats.ovl as ovl_mod
    from modules.formats.utils import dds_conversion

    if not ovl_mod.oodle_compressor:
        # Decompress-only: OvsFile.compress would also need OODLE_CODEC_NAME /
        # INPUT_CHUNK_SIZE (left undefined when the win-dll import fails), but
        # we never write OVLs from here.
        ovl_mod.oodle_compressor = OozDecompressor()
        print("shim: oodle → ooz (libooz.dylib)")

    dds_conversion.dds_to_png = dds_to_png
    # DDS.py does `from ... import dds_conversion` (module ref), so patching
    # the module attribute is enough — no per-call-site rebinding needed.
    print("shim: texconv → texture2ddecoder")
