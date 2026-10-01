<?php
/**
 * Plugin Name: CLEAR CRM Booking Inquiries
 * Description: Delivers Contact Form 7 booking form 238 to Gabe's CRM with signed server requests and retry storage. Existing mail is unchanged.
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) exit;
// Private configuration is deployed separately and is never committed to GitHub.
if (file_exists(__DIR__.'/private-config.php')) require_once __DIR__.'/private-config.php';
function clear_crm_text($data, $key, $limit = 500) {
    $v = isset($data[$key]) && is_scalar($data[$key]) ? (string)$data[$key] : '';
    return function_exists('mb_substr') ? mb_substr(sanitize_textarea_field($v),0,$limit) : substr(sanitize_textarea_field($v),0,$limit);
}
function clear_crm_url($url, $host_only = false) {
    $p = wp_parse_url($url);
    if (!$p || empty($p['host']) || empty($p['scheme']) || !in_array($p['scheme'],array('http','https'),true)) return '';
    return $p['scheme'].'://'.$p['host'].($host_only ? '' : (isset($p['path']) ? $p['path'] : '/'));
}
add_filter('wpcf7_form_hidden_fields', function($fields) {
    $f = WPCF7_ContactForm::get_current();
    if ($f && (int)$f->id()===238) $fields['clear_tracking']='';
    return $fields;
});
add_action('wp_enqueue_scripts', function(){wp_enqueue_script('clear-crm-attribution',plugins_url('tracking.js',__FILE__),array(),'1.0.0',true);});
add_action('wpcf7_submit', function($form,$result) {
    if ((int)$form->id()!==238 || !in_array($result['status']??'',array('mail_sent','mail_failed'),true)) return;
    $submission=WPCF7_Submission::get_instance();
    if (!$submission) return;
    $data=$submission->get_posted_data();
    $map=array('name'=>'your-name','email'=>'your-email','phone'=>'your-phone','organization'=>'your-organization','event_type'=>'your-event','preferred_date'=>'your-date','location'=>'your-location','audience_size'=>'your-audience','details'=>'your-details');
    $fields=array();foreach($map as $key=>$source) $fields[$key]=clear_crm_text($data,$source,$key==='details'?8000:500);
    $fields['organization_type']='Unspecified';
    $raw=json_decode(clear_crm_text($data,'clear_tracking',16000),true);$tracking=array();
    if (is_array($raw)) foreach(array('landing_page','submission_page','referrer','utm_source','utm_medium','utm_campaign','utm_term','utm_content','source') as $key) {
        $v=clear_crm_text($raw,$key,1000);
        $tracking[$key]=in_array($key,array('landing_page','submission_page','referrer'),true)?clear_crm_url($v,$key==='referrer'):$v;
    }
    $id=wp_generate_uuid4();
    $item=array('payload'=>array('form_id'=>238,'submission_id'=>$id,'fields'=>$fields,'tracking'=>$tracking,'mail_status'=>$result['status']),'attempts'=>0,'error'=>'','received'=>time());
    // Separate non-autoloaded options avoid lost submissions during concurrent requests.
    add_option('clear_crm_queue_'.$id,$item,'','no');
    clear_crm_deliver($id);
},10,2);
function clear_crm_deliver($id) {
    if (!preg_match('/^[a-f0-9-]{36}$/',$id)) return;
    $key='clear_crm_queue_'.$id;$item=get_option($key);
    if (!is_array($item)) return;
    if (!defined('CLEAR_CRM_SIGNING_KEY') || !defined('CLEAR_CRM_ENDPOINT')) {$item['error']='Private configuration missing';update_option($key,$item,false);return;}
    $body=wp_json_encode($item['payload']);$ts=(string)time();
    $r=wp_remote_post(CLEAR_CRM_ENDPOINT,array('timeout'=>10,'redirection'=>0,'headers'=>array('Content-Type'=>'application/json','x-clear-timestamp'=>$ts,'x-clear-signature'=>hash_hmac('sha256',$ts.'.'.$body,CLEAR_CRM_SIGNING_KEY)),'body'=>$body));
    $code=is_wp_error($r)?0:wp_remote_retrieve_response_code($r);
    $response=is_wp_error($r)?null:json_decode(wp_remote_retrieve_body($r),true);
    if ($code===200 && !empty($response['ok']) && !empty($response['id'])) {
        delete_option($key);wp_clear_scheduled_hook('clear_crm_retry',array($id));
        update_option('clear_crm_last_delivery',array('time'=>time(),'id'=>$response['id'],'duplicate'=>!empty($response['duplicate'])),false);return;
    }
    $item['attempts']++;$item['error']=is_wp_error($r)?$r->get_error_code():'HTTP '.$code;
    update_option($key,$item,false);
    if ($item['attempts']<10 && !wp_next_scheduled('clear_crm_retry',array($id))) wp_schedule_single_event(time()+min(3600,60*pow(2,min($item['attempts'],6))),'clear_crm_retry',array($id));
}
add_action('clear_crm_retry','clear_crm_deliver');
add_action('admin_menu',function(){add_management_page('CLEAR CRM Delivery','CLEAR CRM Delivery','manage_options','clear-crm-delivery','clear_crm_admin');});
function clear_crm_admin() {
    if (!current_user_can('manage_options')) return;
    global $wpdb;
    if (isset($_POST['clear_retry'])) {check_admin_referer('clear_crm_retry');clear_crm_deliver(sanitize_text_field(wp_unslash($_POST['clear_retry'])));}
    $rows=$wpdb->get_results($wpdb->prepare("SELECT option_name,option_value FROM {$wpdb->options} WHERE option_name LIKE %s",$wpdb->esc_like('clear_crm_queue_').'%'));
    $last=get_option('clear_crm_last_delivery');
    echo '<div class="wrap"><h1>CLEAR CRM Delivery</h1><p>Booking form 238. Email notifications are unchanged. Pending inquiries are retained here if CRM delivery fails.</p>';
    echo '<p>Configuration: '.(defined('CLEAR_CRM_SIGNING_KEY')?'Ready':'Missing').'</p><p>Pending deliveries: '.count($rows).'</p>';
    if($last) echo '<p>Last confirmed delivery: '.esc_html(wp_date('Y-m-d H:i:s',$last['time'])).' — '.esc_html($last['id']).'</p>';
    foreach($rows as $r){$item=maybe_unserialize($r->option_value);$id=substr($r->option_name,strlen('clear_crm_queue_'));echo '<div class="card"><h2>'.esc_html($item['payload']['fields']['organization']?:$item['payload']['fields']['name']).'</h2><p>Attempts: '.(int)$item['attempts'].' · '.esc_html($item['error']).'</p><form method="post">';wp_nonce_field('clear_crm_retry');echo '<button class="button" name="clear_retry" value="'.esc_attr($id).'">Retry delivery</button></form></div>';}
    echo '</div>';
}
