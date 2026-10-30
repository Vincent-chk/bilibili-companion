// Extension-owned AudioWorklet: bounded 16 kHz mono PCM S16LE extraction.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.active=false; this.total=0; this.limit=0; this.used=0; this.chunk=new Uint8Array(8192); this.view=new DataView(this.chunk.buffer);
    this.port.onmessage=event=>{if(event.data?.type==='start'){this.limit=event.data.samples;this.active=true;} else if(event.data?.type==='stop'){this.flush();this.active=false;this.port.postMessage({type:'stopped'});}};
  }
  flush(){if(this.used){const out=this.chunk.slice(0,this.used*2);this.port.postMessage({type:'pcm',buffer:out.buffer},[out.buffer]);this.used=0;}}
  process(inputs){
    if(!this.active)return true;
    const channels=inputs[0];if(!channels?.length||!channels[0]?.length)return true;
    const input=channels[0];
    for(let i=0;i<input.length&&this.total<this.limit;i++){
      const value=Math.max(-1,Math.min(1,input[i]||0));this.view.setInt16(this.used++*2,value<0?Math.round(value*32768):Math.round(value*32767),true);this.total++;
      if(this.used===4096)this.flush();
    }
    if(this.total>=this.limit){this.flush();this.active=false;this.port.postMessage({type:'done',samples:this.total});}
    return true;
  }
}
registerProcessor('doubao-pcm-capture',PcmCapture);
