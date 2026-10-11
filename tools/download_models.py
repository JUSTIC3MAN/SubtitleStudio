"""
download_models.py - fetch every model once so the first song doesn't wait.

    venv\\Scripts\\python tools\\download_models.py           (setup.bat runs this)
    venv\\Scripts\\python tools\\download_models.py --small   (0.6B recogniser too)

Everything lands in SubtitleStudio\\models. Safe to run again; finished files
are skipped.
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HOME", str(ROOT / "models" / "hf"))
sys.path.insert(0, str(ROOT))


def main():
    from studio.asr import ALIGNER_REPO, ENGINES, ensure_hf_model
    from studio import separate

    repos = [(ENGINES["qwen3-1.7b"]["repo"], "Qwen3-ASR 1.7B (recogniser)"), (ALIGNER_REPO, "Qwen3-ForcedAligner (word timing)")]
    if "--small" in sys.argv:
        repos.append((ENGINES["qwen3-0.6b"]["repo"], "Qwen3-ASR 0.6B"))

    last = {"m": ""}

    def report(f, msg):
        if msg and msg != last["m"]:
            print("   " + msg, end="\r", flush=True)
            last["m"] = msg

    ok = True
    for repo, label in repos:
        print(f"\n - {label}")
        try:
            path = ensure_hf_model(repo, report, label)
            print(f"   ready: {path}" + " " * 30)
        except Exception as e:  # noqa: BLE001
            ok = False
            print(f"   FAILED: {e}")

    print("\n - Vocal isolation model (BS-RoFormer)")
    avail, why = separate.available()
    if not avail:
        print("   skipped:", why)
    elif separate.model_cached():
        print("   ready")
    else:
        try:
            from audio_separator.separator import Separator
            separate.MODEL_DIR.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory() as tmp:
                Separator(model_file_dir=str(separate.MODEL_DIR), output_dir=tmp).download_model_files(separate.DEFAULT_MODEL)
            print("   ready")
        except Exception as e:  # noqa: BLE001
            ok = False
            print(f"   FAILED: {e}")

    print()
    print("All models are downloaded." if ok else
          "Some downloads failed - they will be retried automatically the first time you transcribe.")


if __name__ == "__main__":
    main()
