"""시험용 FTP 서버 (pyftpdlib). 운영 대신 쓴다.

사용법: <venv python> -I test/ftp-server.py <루트 폴더> [포트=2121] [사용자=test] [비밀번호=test]
venv: ~/.prod-deploy/test-ftp/venv (python -m venv 후 pip install pyftpdlib)
"""
import os
import sys

from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.filesystems import AbstractedFS
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer


class ReplacingFS(AbstractedFS):
    # Windows 의 os.rename 은 대상이 있으면 실패한다. 운영 FTP 처럼 RNTO 가 덮어쓰게 한다.
    def rename(self, src, dst):
        os.replace(src, dst)


class Handler(FTPHandler):
    # 시험용: 루트 폴더 옆 deny-nlst.txt 에 적힌 폴더(가상 경로, 한 줄에 하나)는 목록(NLST)만 550 으로 거부한다.
    # 운영에서 목록 권한만 없는 계정을 흉내 낸다(파일 받기·올리기는 된다).
    def ftp_NLST(self, path):
        deny = os.path.join(os.path.dirname(self.authorizer.get_home_dir(self.username)), "deny-nlst.txt")
        if os.path.exists(deny):
            vpath = self.fs.fs2ftp(path).rstrip("/") or "/"
            with open(deny, encoding="utf-8") as f:
                for line in f:
                    if line.strip() and vpath == line.strip().rstrip("/"):
                        self.respond("550 Listing permission denied.")
                        return
        return super().ftp_NLST(path)


def main():
    root = os.path.abspath(sys.argv[1])
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 2121
    user = sys.argv[3] if len(sys.argv) > 3 else "test"
    password = sys.argv[4] if len(sys.argv) > 4 else "test"
    os.makedirs(root, exist_ok=True)
    auth = DummyAuthorizer()
    auth.add_user(user, password, root, perm="elradfmwMT")
    handler = Handler
    handler.authorizer = auth
    handler.abstracted_fs = ReplacingFS
    handler.banner = "prod-deploy test ftp"
    server = FTPServer(("127.0.0.1", port), handler)
    print(f"ready ftp://127.0.0.1:{port} root={root}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
