"""시험용 FTP 서버 (pyftpdlib). 운영 대신 쓴다.

사용법: <venv python> -I test/ftp-server.py <루트 폴더> [포트=2121] [사용자=test] [비밀번호=test]
       <venv python> -I test/ftp-server.py --accounts-stdin [포트=2121]
  --accounts-stdin 이면 계정을 명령줄 대신 표준 입력의 JSON 배열 [{"user", "password", "home"}, ...] 으로 받는다
  (비밀번호가 프로세스 인자에 남지 않게. e2e 는 이쪽을 쓴다). 같은 호스트·포트에 계정을 여럿 둘 수 있고, 계정마다 home 이
  홈(chroot)이다. 운영에서 같은 서버의 다른 FTP 계정이 다른 루트를 보는 것을 흉내 낸다. 이름의 앞뒤 공백도 그대로 쓴다.
venv: ~/.prod-deploy/test-ftp/venv (python -m venv 후 pip install pyftpdlib)
"""
import json
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
    if len(sys.argv) > 1 and sys.argv[1] == "--accounts-stdin":
        port = int(sys.argv[2]) if len(sys.argv) > 2 else 2121
        accounts = [(a["user"], a["password"], os.path.abspath(a["home"])) for a in json.loads(sys.stdin.buffer.read().decode("utf-8"))]
    else:
        root = os.path.abspath(sys.argv[1])
        port = int(sys.argv[2]) if len(sys.argv) > 2 else 2121
        user = sys.argv[3] if len(sys.argv) > 3 else "test"
        password = sys.argv[4] if len(sys.argv) > 4 else "test"
        accounts = [(user, password, root)]
    auth = DummyAuthorizer()
    for u, pw, home in accounts:
        os.makedirs(home, exist_ok=True)
        auth.add_user(u, pw, home, perm="elradfmwMT")
    handler = Handler
    handler.authorizer = auth
    handler.abstracted_fs = ReplacingFS
    handler.banner = "prod-deploy test ftp"
    server = FTPServer(("127.0.0.1", port), handler)
    # 계정 이름·홈은 적지 않는다(시험 계정은 이름과 비밀번호가 같기도 하다): 주소와 계정 수만.
    print(f"ready ftp://127.0.0.1:{port} accounts={len(accounts)}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
