
{ pkgs }: {
  deps = [
    pkgs.openjdk11
    pkgs.nodejs-18_x
    pkgs.nodePackages.npm
    pkgs.ffmpeg
  ];
}
