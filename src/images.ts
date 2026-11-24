/** Resize locally before upload; no image processing service or additional bill. */
export async function optimizedThumbnail(file:File):Promise<File>{
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024*1024)throw new Error('Selecione uma imagem JPEG, PNG ou WebP de até 10 MB.');
  const bitmap=await createImageBitmap(file);
  try{
    if(bitmap.width*bitmap.height>40_000_000)throw new Error('A imagem é muito grande. Reduza a resolução antes de enviar.');
    const ratio=Math.min(1,1280/bitmap.width,720/bitmap.height);
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
    const context=canvas.getContext('2d');if(!context)throw new Error('Não foi possível preparar a miniatura.');context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',.8));
    if(!blob||blob.type!=='image/webp'||blob.size>2*1024*1024)throw new Error('Não foi possível comprimir a miniatura. Tente uma imagem menor em um navegador atualizado.');
    return new File([blob],'miniatura.webp',{type:'image/webp'});
  }finally{bitmap.close()}
}
