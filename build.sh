# ดูก่อนว่ามี tag นี้ไหม
git tag --list v1.0.1.prod

# สร้าง tag (แนะนำแบบ annotated)
git tag -a v1.0.1.prod -m "release v1.0.1.prod"

# push tag ขึ้น GitHub
git push evp v1.0.1.prod